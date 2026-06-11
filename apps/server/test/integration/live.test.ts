import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { closeApp, getApp, req, sessionFor } from "../helpers/app.js";
import { SESSION_COOKIE } from "../../src/session.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, grant, member } from "../fixtures/seed.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("live collaboration websocket", () => {
  it("allows an editor token into a document room and rejects unauthenticated clients", async () => {
    const s = await baseScenario();
    const token = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "Live E2E" } });
    expect(token.statusCode).toBe(201);

    const baseUrl = await listeningBaseUrl();
    const authed = new WebSocket(`${baseUrl}/api/live/${s.docId}?token=${encodeURIComponent(token.json().token)}`);
    await expect(openSocket(authed)).resolves.toBeUndefined();
    expect(await firstMessage(authed)).toBeInstanceOf(Buffer);
    authed.close();

    const anonymous = new WebSocket(`${baseUrl}/api/live/${s.docId}`);
    await expect(closedSocket(anonymous)).resolves.toMatchObject({ code: 1008 });
  });

  it("authenticates an editor via the pm_session cookie on the upgrade (browser path)", async () => {
    const s = await baseScenario();
    const sealed = sessionFor(s.admin.id)[SESSION_COOKIE];
    const baseUrl = await listeningBaseUrl();
    const sock = new WebSocket(`${baseUrl}/api/live/${s.docId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sealed}` },
    });
    await expect(openSocket(sock)).resolves.toBeUndefined();
    expect(await firstMessage(sock)).toBeInstanceOf(Buffer);
    sock.close();
  });

  it("rejects authenticated viewers because live editing requires editor access", async () => {
    const s = await baseScenario();
    const viewer = await member(s.ws.id, "live-viewer@t.co");
    await grant(s.ws.id, "user", viewer.user.id, "folder", s.folderId, "viewer");
    const token = await req({ method: "POST", url: "/api/tokens", cookies: viewer.cookie, payload: { name: "Viewer token" } });
    expect(token.statusCode).toBe(201);

    const baseUrl = await listeningBaseUrl();
    const socket = new WebSocket(`${baseUrl}/api/live/${s.docId}?token=${encodeURIComponent(token.json().token)}`);

    await expect(closedSocket(socket)).resolves.toMatchObject({ code: 1008 });
  });

  it("broadcasts Yjs sync and awareness updates between editors", async () => {
    const { baseUrl, token, docId } = await liveEndpoint();
    const left = new WebSocket(`${baseUrl}/api/live/${docId}?token=${encodeURIComponent(token)}`);
    const right = new WebSocket(`${baseUrl}/api/live/${docId}?token=${encodeURIComponent(token)}`);
    const leftMessages = collectMessageTypes(left);
    const rightMessages = collectMessageTypes(right);

    await Promise.all([openSocket(left), openSocket(right)]);
    await expect(leftMessages.next(MESSAGE_SYNC)).resolves.toBe(MESSAGE_SYNC);
    await expect(rightMessages.next(MESSAGE_SYNC)).resolves.toBe(MESSAGE_SYNC);

    left.send(syncUpdate("Hello from left"));
    await expect(rightMessages.next(MESSAGE_SYNC)).resolves.toBe(MESSAGE_SYNC);

    const awarenessDoc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(awarenessDoc);
    awareness.setLocalStateField("user", { name: "Left editor" });
    left.send(awarenessUpdate(awareness, [awarenessDoc.clientID]));
    await expect(rightMessages.next(MESSAGE_AWARENESS)).resolves.toBe(MESSAGE_AWARENESS);

    right.send(queryAwareness());
    await expect(rightMessages.next(MESSAGE_AWARENESS)).resolves.toBe(MESSAGE_AWARENESS);

    left.close();
    right.close();
  });

  it("handles editor messages sent immediately after websocket open", async () => {
    const { baseUrl, token, docId } = await liveEndpoint();
    const socket = new WebSocket(`${baseUrl}/api/live/${docId}?token=${encodeURIComponent(token)}`);

    await openSocket(socket);
    socket.send(syncUpdate("queued before join finishes"));

    expect(messageType(await firstMessage(socket))).toBe(MESSAGE_SYNC);
    socket.close();
  });
});

async function liveEndpoint(): Promise<{ baseUrl: string; token: string; docId: string }> {
  const s = await baseScenario();
  const token = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "Live E2E" } });
  expect(token.statusCode).toBe(201);
  return { baseUrl: await listeningBaseUrl(), token: token.json().token, docId: s.docId };
}

async function listeningBaseUrl(): Promise<string> {
  const app = await getApp();
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test app did not expose a TCP address.");
  return `ws://127.0.0.1:${address.port}`;
}

function openSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function firstMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
}

function closedSocket(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once("error", reject);
  });
}

function messageType(message: unknown): number {
  const decoder = decoding.createDecoder(toUint8Array(message));
  return decoding.readVarUint(decoder);
}

function collectMessageTypes(socket: WebSocket): { next: (expectedType: number) => Promise<number> } {
  const queue: number[] = [];
  const waiters = new Set<() => void>();
  socket.on("message", (message) => {
    queue.push(messageType(message));
    for (const waiter of waiters) waiter();
  });

  return {
    async next(expectedType: number): Promise<number> {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const index = queue.indexOf(expectedType);
        if (index >= 0) return queue.splice(index, 1)[0]!;
        await new Promise<void>((resolve) => {
          const waiter = () => {
            clearTimeout(timeout);
            waiters.delete(waiter);
            resolve();
          };
          const timeout = setTimeout(() => {
            waiters.delete(waiter);
            resolve();
          }, 25);
          waiters.add(waiter);
        });
      }
      throw new Error(`Expected websocket message type ${expectedType}.`);
    },
  };
}

function syncUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(encoder);
}

function awarenessUpdate(awareness: awarenessProtocol.Awareness, clientIds: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds));
  return encoding.toUint8Array(encoder);
}

function queryAwareness(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_QUERY_AWARENESS);
  return encoding.toUint8Array(encoder);
}

function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) return new Uint8Array(Buffer.concat(message));
  throw new TypeError("Expected websocket binary message.");
}
