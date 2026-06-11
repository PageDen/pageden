import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type RawData, WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { authenticate } from "../auth.js";
import { SESSION_COOKIE } from "../session.js";
import { parseCookieHeader } from "./cookies.js";
import { canEditDocument } from "../permissions/index.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

interface LiveRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<WebSocket>;
  controlledIds: Map<WebSocket, Set<number>>;
}

const rooms = new Map<string, LiveRoom>();

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get<{ Params: { documentId: string } }>("/api/live/:documentId", { websocket: true }, (connection, request) => {
    const socket = connection.socket;
    const pending: RawData[] = [];
    let room: LiveRoom | null = null;
    let ready = false;

    const handleMessage = (message: RawData) => {
      if (!room) return;
      handleLiveMessage(room, socket, message);
    };

    socket.on("message", (message) => {
      if (!ready) {
        pending.push(message);
        return;
      }
      handleMessage(message);
    });

    socket.on("close", () => {
      if (room) leaveRoom(room, socket);
    });

    void joinLiveDocument(request, socket)
      .then((joined) => {
        room = joined;
        ready = true;
        for (const message of pending.splice(0)) handleMessage(message);
      })
      .catch(() => {
        socket.close(1008, "unauthorized");
      });
  });
}

async function joinLiveDocument(request: FastifyRequest<{ Params: { documentId: string } }>, socket: WebSocket): Promise<LiveRoom> {
  const token = tokenFromUrl(request.url);
  if (token && !request.headers.authorization) {
    request.headers.authorization = `Bearer ${token}`;
  }

  // Browser clients authenticate with the pm_session cookie carried on the WS upgrade. The
  // cookie plugin's hook may not populate request.cookies for an upgrade, so parse the header
  // directly as a fallback (authenticate() reads request.cookies[SESSION_COOKIE]).
  if (!request.cookies || request.cookies[SESSION_COOKIE] === undefined) {
    const header = typeof request.headers.cookie === "string" ? request.headers.cookie : "";
    request.cookies = { ...(request.cookies ?? {}), ...parseCookieHeader(header) };
  }

  const auth = await authenticate(request);
  if (!auth) throw new Error("unauthorized");
  if (!(await canEditDocument(auth.userId, request.params.documentId))) throw new Error("forbidden");

  const room = getRoom(request.params.documentId);
  room.connections.add(socket);
  room.controlledIds.set(socket, new Set());

  sendSyncStep1(room.doc, socket);
  sendAwareness(room, Array.from(room.awareness.getStates().keys()), socket);

  return room;
}

function getRoom(documentId: string): LiveRoom {
  const existing = rooms.get(documentId);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const room: LiveRoom = { doc, awareness, connections: new Set(), controlledIds: new Map() };

  doc.on("update", (update: Uint8Array) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder));
  });

  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed);
    if (origin instanceof WebSocket) {
      const ids = room.controlledIds.get(origin);
      for (const id of added.concat(updated)) ids?.add(id);
      for (const id of removed) ids?.delete(id);
    }
    sendAwareness(room, changed);
  });

  rooms.set(documentId, room);
  return room;
}

function handleLiveMessage(room: LiveRoom, socket: WebSocket, message: RawData): void {
  const bytes = toUint8Array(message);
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
    return;
  }

  if (messageType === MESSAGE_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), socket);
    return;
  }

  if (messageType === MESSAGE_QUERY_AWARENESS) {
    sendAwareness(room, Array.from(room.awareness.getStates().keys()), socket);
  }
}

function leaveRoom(room: LiveRoom, socket: WebSocket): void {
  room.connections.delete(socket);
  const ids = Array.from(room.controlledIds.get(socket) ?? []);
  room.controlledIds.delete(socket);
  if (ids.length > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, ids, socket);
  }
}

function sendSyncStep1(doc: Y.Doc, socket: WebSocket): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  socket.send(encoding.toUint8Array(encoder));
}

function sendAwareness(room: LiveRoom, clientIds: number[], only?: WebSocket): void {
  if (clientIds.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, clientIds));
  const message = encoding.toUint8Array(encoder);
  if (only) {
    only.send(message);
    return;
  }
  broadcast(room, message);
}

function broadcast(room: LiveRoom, message: Uint8Array): void {
  for (const connection of room.connections) {
    if (connection.readyState === connection.OPEN) connection.send(message);
  }
}

function toUint8Array(message: RawData): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) return new Uint8Array(Buffer.concat(message));
  return new Uint8Array(message);
}

function tokenFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl, "http://pageden.local");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
