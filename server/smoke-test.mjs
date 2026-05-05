// Node-based smoke test: simulates two clients hitting the API the same way
// the browser does, including conflict-resolution. Run while server is up:
//   PORT=3091 node server.js &
//   node smoke-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://127.0.0.1:3091";

async function api(p, init) {
  const res = await fetch(`${BASE}${p}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function uploadAudio(id, bytes, fileName = "test.mp3") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), fileName);
  form.append("fileName", fileName);
  const res = await fetch(`${BASE}/api/audio/${id}`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

function mergeStates(localData, serverData) {
  const merged = { ...serverData, ...localData };
  for (const key of ["scenes", "records", "audio", "issues"]) {
    const localList = Array.isArray(localData[key]) ? localData[key] : [];
    const serverList = Array.isArray(serverData[key]) ? serverData[key] : [];
    const byId = new Map();
    for (const item of serverList) if (item?.id) byId.set(item.id, item);
    for (const item of localList) if (item?.id) byId.set(item.id, item);
    merged[key] = Array.from(byId.values());
  }
  return merged;
}

async function reset() {
  await api("/api/reset", { method: "POST" });
}

let pass = 0;
const t = (name, fn) => fn().then(() => { console.log("✓", name); pass++; });

await reset();

// 1. Initial state is empty + version 1
await t("initial state", async () => {
  const { status, body } = await api("/api/state");
  assert.equal(status, 200);
  assert.deepEqual(body.data, {});
  assert.equal(body.version, 1);
});

// 2. Single PUT bumps version
await t("single PUT", async () => {
  const { status, body } = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { scenes: [{ id: "BZ-001", target: "A" }] }, expectedVersion: 1 }),
  });
  assert.equal(status, 200);
  assert.equal(body.version, 2);
});

// 3. Stale PUT returns 409 + serverData
await t("stale PUT returns 409", async () => {
  const { status, body } = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { scenes: [{ id: "BZ-002", target: "B" }] }, expectedVersion: 1 }),
  });
  assert.equal(status, 409);
  assert.equal(body.currentVersion, 2);
  assert.equal(body.serverData.scenes.length, 1);
  assert.equal(body.serverData.scenes[0].id, "BZ-001");
});

// 4. Merge + retry succeeds and contains both entities
await t("merge + retry", async () => {
  // get latest
  const { body: latest } = await api("/api/state");
  const localOnly = { scenes: [{ id: "BZ-002", target: "B" }] };
  const merged = mergeStates(localOnly, latest.data);
  assert.equal(merged.scenes.length, 2);
  const { status, body } = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: merged, expectedVersion: latest.version }),
  });
  assert.equal(status, 200);
  assert.equal(body.version, 3);
});

// 5. Final state contains both ids
await t("final has both scenes", async () => {
  const { body } = await api("/api/state");
  const ids = body.data.scenes.map((s) => s.id).sort();
  assert.deepEqual(ids, ["BZ-001", "BZ-002"]);
});

// 6. Audio upload + fetch
await t("audio upload roundtrip", async () => {
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // ID3 header tease
  const up = await uploadAudio("AUD-X1", bytes);
  assert.equal(up.status, 200);
  assert.equal(up.body.id, "AUD-X1");
  assert.equal(up.body.size, 4);

  const get = await fetch(`${BASE}/api/audio/AUD-X1`);
  assert.equal(get.status, 200);
  const head = await fetch(`${BASE}/api/audio/AUD-X1`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), 4);
  const buf = new Uint8Array(await get.arrayBuffer());
  assert.deepEqual(Array.from(buf), Array.from(bytes));
});

// 7. Audio delete
await t("audio delete", async () => {
  const del = await fetch(`${BASE}/api/audio/AUD-X1`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const get = await fetch(`${BASE}/api/audio/AUD-X1`);
  assert.equal(get.status, 404);
});

// 8. Concurrent PUTs serialize correctly via the version protocol
await t("concurrent PUTs do not lose data", async () => {
  await reset();
  // both clients fetch v1
  const { body: v1 } = await api("/api/state");
  assert.equal(v1.version, 1);

  // Client A PUTs scene A first (succeeds, v->2)
  const a = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { scenes: [{ id: "S-A", target: "alpha" }] }, expectedVersion: 1 }),
  });
  assert.equal(a.status, 200);

  // Client B (still on v1) PUTs scene B -> 409
  const b = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { scenes: [{ id: "S-B", target: "beta" }] }, expectedVersion: 1 }),
  });
  assert.equal(b.status, 409);

  // Client B merges, retries with v2
  const merged = mergeStates({ scenes: [{ id: "S-B", target: "beta" }] }, b.body.serverData);
  const b2 = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: merged, expectedVersion: b.body.currentVersion }),
  });
  assert.equal(b2.status, 200);
  const { body: final } = await api("/api/state");
  const ids = final.data.scenes.map((s) => s.id).sort();
  assert.deepEqual(ids, ["S-A", "S-B"]);
});

// 9. Version endpoint is cheap + accurate
await t("version endpoint", async () => {
  const { body: full } = await api("/api/state");
  const { body: ver } = await api("/api/state/version");
  assert.equal(ver.version, full.version);
  assert.ok(!("data" in ver));
});

console.log(`\n${pass} tests passed.`);
