// One-shot import of an existing localStorage JSON export into the shared
// backend. Useful for migrating data from a single user's browser after they
// click "导出 JSON" but before everyone switches to the multi-user version.
//
// Usage:
//   node import-state.mjs path/to/aicp-sop-training-1234.json [BASE_URL]
//
// Default BASE_URL is http://127.0.0.1:3000.
//
// What it does:
//   1. Reads the JSON file (the same shape as state).
//   2. Strips currentUser (per-browser, not shared).
//   3. Fetches current server state to learn its version.
//   4. Merges the file's data into server data (file wins per id).
//   5. PUTs the merged result with the correct expectedVersion.
//
// Audio blobs are NOT migrated — they live only in the original browser's
// IndexedDB. After running this, anyone who recorded audio should re-upload
// from the audio panel.

import fs from "node:fs/promises";

const [, , filePath, baseArg] = process.argv;
const BASE = baseArg || process.env.BASE || "http://127.0.0.1:3000";

if (!filePath) {
  console.error("usage: node import-state.mjs <state-export.json> [base-url]");
  process.exit(1);
}

const raw = await fs.readFile(filePath, "utf8");
const localData = JSON.parse(raw);
delete localData.currentUser; // per-browser, never share

const cur = await fetch(`${BASE}/api/state`).then((r) => r.json());
const serverData = cur.data || {};
const merged = { ...serverData, ...localData };

for (const key of ["scenes", "records", "audio", "issues"]) {
  const localList = Array.isArray(localData[key]) ? localData[key] : [];
  const serverList = Array.isArray(serverData[key]) ? serverData[key] : [];
  const byId = new Map();
  for (const item of serverList) if (item?.id) byId.set(item.id, item);
  for (const item of localList) if (item?.id) byId.set(item.id, item);
  merged[key] = Array.from(byId.values());
}

if (localData.dictionaries || serverData.dictionaries) {
  merged.dictionaries = {
    ...(serverData.dictionaries || {}),
    ...(localData.dictionaries || {}),
  };
}

const res = await fetch(`${BASE}/api/state`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: merged, expectedVersion: cur.version }),
});

if (!res.ok) {
  console.error("import failed:", res.status, await res.text());
  process.exit(1);
}
const body = await res.json();
console.log(`imported. new version = ${body.version}`);
console.log("Note: audio files were NOT migrated. Re-upload from the audio panel.");
