import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WEAPON_LIST, WEAPON_REGISTRY } from "@game/shared";
import { ADMIN_PAGE_HTML } from "./adminPage.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_UPLOADS_PER_MINUTE = 12;

export interface UploadRecord {
  id: string;
  weaponId: string;
  label: string;
  originalName: string;
  bytes: number;
  createdAt: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Keeps a human label readable and harmless: no control characters, bounded length. */
function cleanText(value: string | null, fallback: string, max: number): string {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
  return cleaned || fallback;
}

/** A glTF binary starts with "glTF", version 2, and a header length equal to the file size. */
async function isValidGlb(path: string, bytes: number): Promise<boolean> {
  if (bytes < 20) return false;
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    return header.toString("ascii", 0, 4) === "glTF" && header.readUInt32LE(4) === 2 && header.readUInt32LE(8) === bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Private upload area for new weapon models. Files are only stored, never served to players: the game
 * picks them up after they have been checked and optimised by hand.
 *
 * The whole module is disabled (every route 404s) unless a password is configured.
 */
export function createAdminHandler(options: { password?: string; uploadDir: string; maxBytes?: number }) {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const passwordHash = options.password ? sha256(options.password) : null;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const recentUploads: number[] = [];

  const clientIp = (req: IncomingMessage): string =>
    String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();

  function authorize(req: IncomingMessage): void {
    const ip = clientIp(req);
    const now = Date.now();
    const record = failures.get(ip);
    if (record && record.resetAt > now && record.count >= MAX_FAILED_LOGINS) {
      throw new HttpError(429, "Too many wrong passwords. Try again in a few minutes.");
    }
    const supplied = String(req.headers["x-admin-password"] ?? "");
    if (passwordHash && timingSafeEqual(sha256(supplied), passwordHash)) {
      failures.delete(ip);
      return;
    }
    const next = record && record.resetAt > now ? record : { count: 0, resetAt: now + FAILED_LOGIN_WINDOW_MS };
    next.count++;
    failures.set(ip, next);
    throw new HttpError(401, "Wrong password.");
  }

  async function readRecords(): Promise<UploadRecord[]> {
    await mkdir(options.uploadDir, { recursive: true });
    const records: UploadRecord[] = [];
    for (const name of await readdir(options.uploadDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(join(options.uploadDir, name), "utf8")) as UploadRecord);
      } catch {
        // Skip a half-written or corrupt record rather than failing the whole list.
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function receiveUpload(req: IncomingMessage, url: URL): Promise<UploadRecord> {
    const weaponId = url.searchParams.get("weaponId") ?? "";
    if (!WEAPON_REGISTRY[weaponId]) throw new HttpError(400, "Unknown weapon.");
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared <= 0) throw new HttpError(411, "A Content-Length header is required.");
    if (declared > maxBytes) throw new HttpError(413, "File is larger than " + Math.round(maxBytes / 1048576) + " MB.");

    const now = Date.now();
    while (recentUploads.length && recentUploads[0] < now - 60_000) recentUploads.shift();
    if (recentUploads.length >= MAX_UPLOADS_PER_MINUTE) throw new HttpError(429, "Too many uploads. Wait a minute.");
    recentUploads.push(now);

    await mkdir(options.uploadDir, { recursive: true });
    const id = randomBytes(8).toString("hex");
    const finalPath = join(options.uploadDir, id + ".glb");
    const tempPath = finalPath + ".part";
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) callback(new HttpError(413, "File is larger than the upload limit."));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tempPath));
      if (!(await isValidGlb(tempPath, received))) {
        throw new HttpError(400, "That is not a valid .glb file (binary glTF 2.0).");
      }
      await rename(tempPath, finalPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    const record: UploadRecord = {
      id,
      weaponId,
      label: cleanText(url.searchParams.get("label"), "Untitled", 60),
      originalName: cleanText(url.searchParams.get("filename"), id + ".glb", 120),
      bytes: received,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(options.uploadDir, id + ".json"), JSON.stringify(record, null, 2));
    return record;
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === "/admin" || pathname === "/admin/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      });
      res.end(ADMIN_PAGE_HTML);
      return;
    }

    authorize(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (pathname === "/api/admin/session" && req.method === "GET") {
      sendJson(res, 200, { ok: true, maxBytes });
      return;
    }
    if (pathname === "/api/admin/guns" && req.method === "GET") {
      sendJson(res, 200, {
        guns: WEAPON_LIST.map((weapon) => ({ id: weapon.id, name: weapon.name, category: weapon.category })),
        uploads: await readRecords(),
        maxBytes,
      });
      return;
    }
    if (pathname === "/api/admin/uploads" && req.method === "POST") {
      sendJson(res, 201, await receiveUpload(req, url));
      return;
    }

    const match = /^\/api\/admin\/uploads\/([a-f0-9]{16})(\/file)?$/.exec(pathname);
    if (match) {
      const [, id, file] = match;
      const base = join(options.uploadDir, id);
      if (file && req.method === "GET") {
        const info = await stat(base + ".glb").catch(() => null);
        if (!info) throw new HttpError(404, "No such upload.");
        res.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": info.size, "Cache-Control": "no-store" });
        const handle = await open(base + ".glb", "r");
        handle.createReadStream().pipe(res);
        return;
      }
      if (!file && req.method === "DELETE") {
        await rm(base + ".glb", { force: true });
        await rm(base + ".json", { force: true });
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    throw new HttpError(404, "Not found.");
  }

  /** Returns true when the request belongs to the admin area (and has been, or will be, answered). */
  return function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname !== "/admin" && pathname !== "/admin/" && !pathname.startsWith("/api/admin/")) return false;
    if (!passwordHash) {
      res.writeHead(404);
      res.end("Not found");
      return true;
    }
    route(req, res, pathname).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // Unread request bodies would otherwise keep the connection busy after an early refusal.
        res.setHeader("Connection", "close");
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.warn("Admin request failed", error);
      sendJson(res, 500, { error: "Server error." });
    });
    return true;
  };
}
