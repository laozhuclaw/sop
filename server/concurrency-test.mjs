// Concurrency stress test for the AICP SOP backend.
//
// Simulates N browser sessions all writing at once. Each "client" pushes
// its own entities into scenes/records/audio/issues, retries on 409 by
// merging server state, and stops when its write is accepted. After all
// clients finish we verify the final state contains *every* entity from
// *every* client (no lost writes), then we delete the probe data so the
// server is left in its baseline state.
//
// Run against local:    BASE=http://127.0.0.1:3091 node concurrency-test.mjs
// Run against prod:     BASE=http://47.102.216.22/sop node concurrency-test.mjs
//
// Tunables via env:
//   CLIENTS=8           number of parallel writers
//   PER_CLIENT=3        entities each writer pushes per kind
//   MAX_RETRIES=20      bound on the 409→merge retry loop
//   PROBE_PREFIX=__C    prefix for sentinel ids (used for cleanup)

import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://127.0.0.1:3091";
const CLIENTS = Number(process.env.CLIENTS || 8);
const PER_CLIENT = Number(process.env.PER_CLIENT || 3);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 20);
const PROBE_PREFIX = process.env.PROBE_PREFIX || "__C";
const KINDS = ["scenes", "records", "audio", "issues"];

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const PUT = (data, expectedVersion) =>
  api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, expectedVersion }),
  });

// Same id-keyed merge the frontend does: local edits win per id, but
// server-only entries are preserved.
function mergeStates(localData, serverData) {
  const merged = { ...serverData, ...localData };
  for (const k of KINDS) {
    const sl = Array.isArray(serverData?.[k]) ? serverData[k] : [];
    const ll = Array.isArray(localData?.[k]) ? localData[k] : [];
    const byId = new Map();
    for (const it of sl) if (it?.id) byId.set(it.id, it);
    for (const it of ll) if (it?.id) byId.set(it.id, it);
    merged[k] = Array.from(byId.values());
  }
  return merged;
}

function clientEntities(clientIdx) {
  const out = {};
  for (const k of KINDS) {
    out[k] = Array.from({ length: PER_CLIENT }, (_, i) => ({
      id: `${PROBE_PREFIX}-c${clientIdx}-${k}-${i}`,
      kind: k,
      client: clientIdx,
      seq: i,
      tags: "测试数据",
    }));
  }
  return out;
}

async function clientLoop(idx, baseline) {
  // Each client maintains its own desired entities. On 409 we merge with
  // the server's current data and retry with the bumped expected version.
  const mine = clientEntities(idx);
  let attempts = 0;
  let conflicts = 0;
  let mergedFromServer = baseline.data || {};
  let expectedVersion = baseline.version;

  while (attempts < MAX_RETRIES) {
    attempts += 1;
    const desired = mergeStates(mine, mergedFromServer);
    const { status, body } = await PUT(desired, expectedVersion);
    if (status === 200) {
      return { idx, attempts, conflicts, finalVersion: body.version };
    }
    if (status === 409) {
      conflicts += 1;
      mergedFromServer = body.serverData || {};
      expectedVersion = body.currentVersion;
      // tiny jitter so clients don't sync up
      await new Promise((r) => setTimeout(r, Math.random() * 30));
      continue;
    }
    throw new Error(`client ${idx} unexpected status ${status}: ${JSON.stringify(body)}`);
  }
  throw new Error(`client ${idx} exceeded ${MAX_RETRIES} retries`);
}

async function readBaseline() {
  const { body } = await api("/api/state");
  return { version: body.version, data: body.data || {} };
}

async function deleteProbeEntities(prefix) {
  // Walk version forward until our cleanup PUT lands.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { body: latest } = await api("/api/state");
    const cleaned = { ...latest.data };
    for (const k of KINDS) {
      cleaned[k] = (latest.data[k] || []).filter((it) => !String(it?.id || "").startsWith(prefix));
    }
    const { status } = await PUT(cleaned, latest.version);
    if (status === 200) return;
    if (status !== 409) throw new Error(`cleanup got status ${status}`);
  }
  throw new Error("cleanup exceeded retries");
}

console.log(`Stress test against ${BASE}`);
console.log(`Clients: ${CLIENTS}, per-client per-kind: ${PER_CLIENT}, kinds: ${KINDS.join("/")}`);
console.log(`Total entities to land: ${CLIENTS * PER_CLIENT * KINDS.length}\n`);

const baseline = await readBaseline();
console.log(`Baseline version: ${baseline.version}`);

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: CLIENTS }, (_, idx) => clientLoop(idx, baseline)),
);
const elapsed = Date.now() - t0;

console.log(`\nAll ${CLIENTS} clients finished in ${elapsed}ms`);
console.log("attempts/conflicts per client:");
for (const r of results) {
  console.log(`  client ${r.idx}: ${r.attempts} attempts, ${r.conflicts} conflicts, finalVersion=${r.finalVersion}`);
}
const totalConflicts = results.reduce((a, r) => a + r.conflicts, 0);
const totalAttempts = results.reduce((a, r) => a + r.attempts, 0);
console.log(`Aggregate: ${totalAttempts} attempts, ${totalConflicts} conflicts`);

// Verify all entities landed
const { body: final } = await api("/api/state");
const haveByKind = {};
for (const k of KINDS) {
  haveByKind[k] = new Set((final.data[k] || []).map((it) => it.id));
}
const missing = [];
for (let c = 0; c < CLIENTS; c += 1) {
  for (const k of KINDS) {
    for (let i = 0; i < PER_CLIENT; i += 1) {
      const id = `${PROBE_PREFIX}-c${c}-${k}-${i}`;
      if (!haveByKind[k].has(id)) missing.push(id);
    }
  }
}
assert.equal(missing.length, 0, `lost writes: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "..." : ""}`);
console.log(`✓ All ${CLIENTS * PER_CLIENT * KINDS.length} entities landed; final version = ${final.version}`);

// Cleanup
await deleteProbeEntities(PROBE_PREFIX);
const { body: afterCleanup } = await api("/api/state");
let leftovers = 0;
for (const k of KINDS) leftovers += (afterCleanup.data[k] || []).filter((it) => String(it.id || "").startsWith(PROBE_PREFIX)).length;
assert.equal(leftovers, 0, `cleanup left ${leftovers} probe entities behind`);
console.log(`✓ Cleanup complete; baseline restored at version ${afterCleanup.version}`);
