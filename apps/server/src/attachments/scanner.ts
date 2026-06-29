import { createConnection } from "node:net";
import { AttachmentStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { readBlob } from "../storage.js";

type ScanResult = "clean" | "infected";
type ScannerFn = (data: Buffer) => Promise<ScanResult>;
const SCAN_ATTEMPTS = 3;
const SCAN_RETRY_DELAY_MS = 1_000;

let _scannerOverride: ScannerFn | undefined;

/** Replace the real ClamAV scanner — for tests only. Pass undefined to restore default. */
export function setScanner(fn: ScannerFn | undefined): void {
  _scannerOverride = fn;
}

async function clamavScan(data: Buffer, url: string): Promise<ScanResult> {
  const match = /^tcp:\/\/([^:]+):(\d+)$/.exec(url);
  if (!match) throw new Error(`Invalid CLAMAV_URL: ${url}`);
  const [, host, portStr] = match;
  const port = Number(portStr);

  return new Promise<ScanResult>((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      const CHUNK = 4096;
      for (let i = 0; i < data.length; i += CHUNK) {
        const slice = data.subarray(i, i + CHUNK);
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32BE(slice.length, 0);
        socket.write(lenBuf);
        socket.write(slice);
      }
      socket.write(Buffer.alloc(4)); // terminate stream
    });

    let response = "";
    socket.on("data", (d: Buffer) => { response += d.toString(); });
    socket.on("end", () => {
      socket.destroy();
      resolve(response.includes("FOUND") ? "infected" : "clean");
    });
    socket.on("error", (err) => { socket.destroy(); reject(err); });
    socket.setTimeout(30_000, () => { socket.destroy(); reject(new Error("ClamAV scan timed out")); });
  });
}

async function doScan(data: Buffer): Promise<ScanResult> {
  if (_scannerOverride) return _scannerOverride(data);
  if (!env.clamavUrl) return "clean";
  return clamavScan(data, env.clamavUrl);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectionRefused(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ECONNREFUSED";
}

// ---------------------------------------------------------------------------
// Single-flight worker
// ---------------------------------------------------------------------------
let workerRunning = false;
let _workerPromise: Promise<void> | undefined;

/** Kick the scan worker. No-op if already running. */
export function kickScanWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  _workerPromise = (async () => {
    try {
      for (;;) {
        const att = await prisma.attachment.findFirst({
          where: { status: AttachmentStatus.SCANNING },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (!att) break;
        await processAttachment(att.id);
      }
    } catch (error) {
      console.error("[scanner] worker loop failed", error);
    } finally {
      workerRunning = false;
      _workerPromise = undefined;
    }
  })();
}

/** Awaits the running worker. Resolves immediately if idle. Used by tests. */
export async function drainScanWorker(): Promise<void> {
  if (_workerPromise) await _workerPromise;
}

/** On boot: kick the worker so attachments stuck in SCANNING from a prior crash get processed. */
export function recoverStuckScanJobs(): void {
  kickScanWorker();
}

async function processAttachment(attachmentId: string): Promise<void> {
  const att = await prisma.attachment.findFirst({
    where: { id: attachmentId, status: AttachmentStatus.SCANNING },
    select: { id: true, storageKey: true },
  });
  if (!att) return;

  let result: ScanResult | undefined;
  let lastError: unknown;
  try {
    const data = await readBlob(att.storageKey);
    for (let attempt = 1; attempt <= SCAN_ATTEMPTS; attempt += 1) {
      try {
        result = await doScan(data);
        break;
      } catch (error) {
        if (attempt === 1 && isConnectionRefused(error)) {
          console.warn("[scanner] ClamAV unavailable, treating as clean:", error);
          result = "clean";
          break;
        }
        lastError = error;
        if (attempt < SCAN_ATTEMPTS) await delay(SCAN_RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    lastError = error;
  }

  if (!result) {
    console.error(`[scanner] failed scanning attachment ${attachmentId}; marking scan_failed:`, lastError);
    await prisma.attachment.updateMany({
      where: { id: attachmentId, status: AttachmentStatus.SCANNING },
      data: { status: AttachmentStatus.SCAN_FAILED },
    });
    return;
  }

  await prisma.attachment.updateMany({
    where: { id: attachmentId, status: AttachmentStatus.SCANNING },
    data: { status: result === "clean" ? AttachmentStatus.READY : AttachmentStatus.QUARANTINED },
  });

  if (result === "infected") {
    console.warn(`[scanner] attachment ${attachmentId} QUARANTINED — malware detected`);
  }
}
