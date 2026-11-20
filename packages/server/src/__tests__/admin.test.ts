import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminHandler } from "../admin/AdminModule.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A structurally valid binary glTF: header, then padding standing in for the chunks. */
function fakeGlb(totalBytes = 64): Buffer {
  const buf = Buffer.alloc(totalBytes);
  buf.write("glTF", 0, "ascii");
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(totalBytes, 8);
  return buf;
}

async function start(options: { password?: string; maxBytes?: number } = {}) {
  const uploadDir = await mkdtemp(join(tmpdir(), "admin-test-"));
  const handle = createAdminHandler({ password: "demo-pass", uploadDir, ...options });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (!handle(req, res, pathname)) {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(uploadDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { "x-admin-password": "demo-pass" };
  return { base, auth, uploadDir };
}

describe("admin weapon-model uploads", () => {
  it("is invisible when no password is configured", async () => {
    const { base } = await start({ password: undefined });
    expect((await fetch(base + "/admin")).status).toBe(404);
    expect((await fetch(base + "/api/admin/guns")).status).toBe(404);
  });

  it("serves the page, and rejects a missing or wrong password", async () => {
    const { base } = await start();
    const page = await fetch(base + "/admin");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Weapon model uploads");
    expect((await fetch(base + "/api/admin/guns")).status).toBe(401);
    expect((await fetch(base + "/api/admin/guns", { headers: { "x-admin-password": "nope" } })).status).toBe(401);
  });

  it("locks an address out after repeated wrong passwords", async () => {
    const { base, auth } = await start();
    for (let i = 0; i < 10; i++) await fetch(base + "/api/admin/guns", { headers: { "x-admin-password": "bad" + i } });
    expect((await fetch(base + "/api/admin/guns", { headers: auth })).status).toBe(429);
  });

  it("lists the existing guns", async () => {
    const { base, auth } = await start();
    const data = await (await fetch(base + "/api/admin/guns", { headers: auth })).json() as { guns: { id: string }[] };
    expect(data.guns.map((g) => g.id)).toContain("m416");
  });

  it("stores a valid .glb, lists it, serves it back for preview and deletes it", async () => {
    const { base, auth, uploadDir } = await start();
    const body = fakeGlb(128);
    const created = await fetch(base + "/api/admin/uploads?weaponId=m416&label=Gold%20Edition&filename=gold.glb",
      { method: "POST", headers: auth, body });
    expect(created.status).toBe(201);
    const record = await created.json() as { id: string; weaponId: string; label: string; bytes: number };
    expect(record).toMatchObject({ weaponId: "m416", label: "Gold Edition", bytes: 128 });

    const list = await (await fetch(base + "/api/admin/guns", { headers: auth })).json() as { uploads: { id: string }[] };
    expect(list.uploads.map((u) => u.id)).toEqual([record.id]);

    const file = await fetch(`${base}/api/admin/uploads/${record.id}/file`, { headers: auth });
    expect(file.headers.get("content-type")).toBe("model/gltf-binary");
    expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);

    expect((await fetch(`${base}/api/admin/uploads/${record.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it("rejects files that are not binary glTF and leaves nothing behind", async () => {
    const { base, auth, uploadDir } = await start();
    const res = await fetch(base + "/api/admin/uploads?weaponId=m416&label=x", { method: "POST", headers: auth, body: Buffer.alloc(100, 7) });
    expect(res.status).toBe(400);
    const wrongLength = fakeGlb(64);
    wrongLength.writeUInt32LE(9999, 8);
    expect((await fetch(base + "/api/admin/uploads?weaponId=m416", { method: "POST", headers: auth, body: wrongLength })).status).toBe(400);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it("rejects unknown weapons and oversized files", async () => {
    const { base, auth, uploadDir } = await start({ maxBytes: 200 });
    expect((await fetch(base + "/api/admin/uploads?weaponId=laser", { method: "POST", headers: auth, body: fakeGlb() })).status).toBe(400);
    expect((await fetch(base + "/api/admin/uploads?weaponId=m416", { method: "POST", headers: auth, body: fakeGlb(400) })).status).toBe(413);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it("never lets an upload id escape the upload folder", async () => {
    const { base, auth } = await start();
    expect((await fetch(base + "/api/admin/uploads/..%2F..%2Fetc%2Fpasswd/file", { headers: auth })).status).toBe(404);
  });
});
