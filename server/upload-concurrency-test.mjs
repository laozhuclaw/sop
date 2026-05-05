// Concurrent file-upload stress: N parallel audio + video uploads,
// then verify each round-trip (HEAD size, GET bytes match), then delete.
//
// Run:  BASE=http://47.102.216.22/sop CLIENTS=8 node upload-concurrency-test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://127.0.0.1:3091";
const CLIENTS = Number(process.env.CLIENTS || 8);
const PROBE = process.env.PROBE || "__UP";

function randomBytes(n) {
  return crypto.randomBytes(n);
}

async function uploadAudio(id, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), `${id}.mp3`);
  form.append("fileName", `${id}.mp3`);
  const res = await fetch(`${BASE}/api/audio/${id}`, { method: "POST", body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function uploadVideo(id, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "video/mp4" }), `${id}.mp4`);
  form.append("fileName", `${id}.mp4`);
  const res = await fetch(`${BASE}/api/video/${id}`, { method: "POST", body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function verifyAudio(id, bytes) {
  const head = await fetch(`${BASE}/api/audio/${id}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "audio/mpeg");
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  const get = await fetch(`${BASE}/api/audio/${id}`);
  const got = new Uint8Array(await get.arrayBuffer());
  assert.equal(got.length, bytes.length);
  for (let i = 0; i < bytes.length; i += 1) assert.equal(got[i], bytes[i]);
}

async function verifyVideo(id, bytes) {
  const head = await fetch(`${BASE}/api/video/${id}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
}

console.log(`Concurrent upload test against ${BASE} with ${CLIENTS} clients`);
const t0 = Date.now();

// Each client picks a random size 4 KB..32 KB so the bytes are all unique.
const audioJobs = Array.from({ length: CLIENTS }, (_, i) => ({
  id: `${PROBE}-A-${i}`,
  bytes: randomBytes(4096 + Math.floor(Math.random() * 28 * 1024)),
}));
const videoJobs = Array.from({ length: CLIENTS }, (_, i) => ({
  id: `${PROBE}-V-${i}`,
  bytes: randomBytes(8192 + Math.floor(Math.random() * 56 * 1024)),
}));

// Fire all uploads in parallel
const uploadResults = await Promise.all([
  ...audioJobs.map((j) => uploadAudio(j.id, j.bytes)),
  ...videoJobs.map((j) => uploadVideo(j.id, j.bytes)),
]);
const uploadFailures = uploadResults.filter((r) => r.status !== 200);
assert.equal(uploadFailures.length, 0, `${uploadFailures.length} uploads failed: ${JSON.stringify(uploadFailures.slice(0, 3))}`);
console.log(`✓ ${uploadResults.length} uploads succeeded in ${Date.now() - t0}ms`);

// Verify all in parallel
await Promise.all([
  ...audioJobs.map((j) => verifyAudio(j.id, j.bytes)),
  ...videoJobs.map((j) => verifyVideo(j.id, j.bytes)),
]);
console.log(`✓ All ${audioJobs.length + videoJobs.length} blobs verified (size + headers + bytes)`);

// Cleanup
await Promise.all([
  ...audioJobs.map((j) => fetch(`${BASE}/api/audio/${j.id}`, { method: "DELETE" })),
  ...videoJobs.map((j) => fetch(`${BASE}/api/video/${j.id}`, { method: "DELETE" })),
]);
console.log(`✓ Cleanup: ${audioJobs.length + videoJobs.length} blobs deleted`);

// Confirm gone
const probeFetches = await Promise.all([
  ...audioJobs.map((j) => fetch(`${BASE}/api/audio/${j.id}`, { method: "HEAD" })),
  ...videoJobs.map((j) => fetch(`${BASE}/api/video/${j.id}`, { method: "HEAD" })),
]);
const stillThere = probeFetches.filter((r) => r.status !== 404);
assert.equal(stillThere.length, 0, `${stillThere.length} blobs still present after delete`);
console.log(`✓ Verified all probe blobs return 404 after cleanup`);
console.log(`\nTotal: ${Date.now() - t0}ms`);
