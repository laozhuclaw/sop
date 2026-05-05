"use strict";

/**
 * AICP SOP Console - shared backend.
 *
 * Responsibilities:
 *  - Persist a single shared `state` object (the same shape the frontend already uses).
 *  - Store uploaded .mp3 audio blobs on the filesystem.
 *  - Serve the static frontend (index.html, script.js, styles.css, image).
 *
 * Concurrency model: optimistic versioning.
 *   - GET /api/state returns { data, version }.
 *   - PUT /api/state requires { data, expectedVersion }; mismatch -> 409.
 *   - Frontend polls every few seconds and re-fetches on bumped version.
 *
 * Storage:
 *   - data/state.json (atomically written via tmp + rename)
 *   - data/uploads/<audioId>.mp3       (binary)
 *   - data/uploads/<audioId>.meta.json (originalName, mime, size, uploadedAt)
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STATE_TMP = path.join(DATA_DIR, "state.json.tmp");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const BODY_LIMIT = process.env.BODY_LIMIT || "20mb";
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 50);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // optional: required for /api/reset

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- in-process write lock for state.json ----------------------------------
// Express handles requests on a single thread, but writes go through fs which
// can interleave with concurrent reads. A simple promise chain serializes
// state mutations.
let stateChain = Promise.resolve();
function withStateLock(fn) {
  const next = stateChain.then(fn, fn);
  // Don't let one rejection poison the chain.
  stateChain = next.catch(() => {});
  return next;
}

// --- state file --------------------------------------------------------------
function emptyState() {
  // The frontend's normalizeState() fills in defaults from initialData, so we
  // can safely persist an empty object on first boot. Version starts at 1.
  return { data: {}, version: 1, updatedAt: new Date().toISOString() };
}

async function readState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    if (typeof parsed.version !== "number") parsed.version = 1;
    if (!parsed.data || typeof parsed.data !== "object") parsed.data = {};
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
}

async function writeStateAtomically(stateObj) {
  const json = JSON.stringify(stateObj, null, 2);
  await fsp.writeFile(STATE_TMP, json, "utf8");
  await fsp.rename(STATE_TMP, STATE_FILE);
}

// --- audio storage -----------------------------------------------------------
function audioPaths(id) {
  // sanitize: ids look like AUD-001 in the frontend, but accept anything safe.
  const safe = String(id).replace(/[^A-Za-z0-9_\-]/g, "");
  if (!safe) throw new Error("invalid audio id");
  return {
    blob: path.join(UPLOAD_DIR, `${safe}.mp3`),
    meta: path.join(UPLOAD_DIR, `${safe}.meta.json`),
    safeId: safe,
  };
}

// --- express app -------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: BODY_LIMIT }));

// CORS: allow same-origin only by default; permit override for dev.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "";
if (ALLOW_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Token");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

// Tiny request log so production logs are useful.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(new Date().toISOString(), req.method, req.path);
  }
  next();
});

// --- API: state --------------------------------------------------------------
app.get("/api/state", async (_req, res) => {
  try {
    const s = await readState();
    res.json(s);
  } catch (err) {
    console.error("readState failed", err);
    res.status(500).json({ error: "read_failed" });
  }
});

app.get("/api/state/version", async (_req, res) => {
  // lightweight poll endpoint — only returns version + updatedAt
  try {
    const s = await readState();
    res.json({ version: s.version, updatedAt: s.updatedAt });
  } catch (err) {
    console.error("readState failed", err);
    res.status(500).json({ error: "read_failed" });
  }
});

app.put("/api/state", async (req, res) => {
  const { data, expectedVersion } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "data_required" });
  }
  try {
    const result = await withStateLock(async () => {
      const current = await readState();
      if (
        typeof expectedVersion === "number" &&
        expectedVersion !== current.version
      ) {
        const conflict = new Error("version_conflict");
        conflict.status = 409;
        conflict.payload = {
          error: "version_conflict",
          currentVersion: current.version,
          serverData: current.data,
        };
        throw conflict;
      }
      const next = {
        data,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await writeStateAtomically(next);
      return next;
    });
    res.json({ version: result.version, updatedAt: result.updatedAt });
  } catch (err) {
    if (err.status === 409) return res.status(409).json(err.payload);
    console.error("PUT /api/state failed", err);
    res.status(500).json({ error: "write_failed" });
  }
});

// Admin reset: dangerous, requires token if configured.
app.post("/api/reset", async (req, res) => {
  if (ADMIN_TOKEN && req.get("X-Admin-Token") !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    await withStateLock(async () => {
      await writeStateAtomically(emptyState());
    });
    // also wipe uploads
    const entries = await fsp.readdir(UPLOAD_DIR);
    await Promise.all(
      entries.map((name) => fsp.unlink(path.join(UPLOAD_DIR, name)).catch(() => {})),
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("reset failed", err);
    res.status(500).json({ error: "reset_failed" });
  }
});

// --- API: audio --------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
});

app.post("/api/audio/:id", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  try {
    const { blob, meta, safeId } = audioPaths(req.params.id);
    const fileName = req.body.fileName || req.file.originalname || `${safeId}.mp3`;
    const mimeType = req.file.mimetype || "audio/mpeg";
    const size = req.file.size;
    const uploadedAt = new Date().toISOString();
    const checksum = crypto
      .createHash("sha1")
      .update(req.file.buffer)
      .digest("hex");

    await fsp.writeFile(blob, req.file.buffer);
    await fsp.writeFile(
      meta,
      JSON.stringify({ id: safeId, fileName, mimeType, size, uploadedAt, checksum }, null, 2),
      "utf8",
    );
    res.json({ id: safeId, fileName, size, uploadedAt, checksum });
  } catch (err) {
    console.error("audio upload failed", err);
    res.status(500).json({ error: "upload_failed" });
  }
});

async function audioFileInfo(id) {
  const { blob, meta } = audioPaths(id);
  let metaInfo = null;
  try {
    metaInfo = JSON.parse(await fsp.readFile(meta, "utf8"));
  } catch {}
  const stat = await fsp.stat(blob).catch(() => null);
  return { blob, metaInfo, stat };
}

function setAudioHeaders(res, stat, metaInfo) {
  res.setHeader("Content-Type", metaInfo?.mimeType || "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  if (metaInfo?.checksum) res.setHeader("X-Audio-Checksum", metaInfo.checksum);
  if (metaInfo?.fileName) {
    // Allow inline playback; download attribute on the link forces download.
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(metaInfo.fileName)}`,
    );
  }
}

app.head("/api/audio/:id", async (req, res) => {
  try {
    const { metaInfo, stat } = await audioFileInfo(req.params.id);
    if (!stat) return res.sendStatus(404);
    setAudioHeaders(res, stat, metaInfo);
    res.status(200).end();
  } catch (err) {
    console.error("audio head failed", err);
    res.sendStatus(500);
  }
});

app.get("/api/audio/:id", async (req, res) => {
  try {
    const { blob, metaInfo, stat } = await audioFileInfo(req.params.id);
    if (!stat) return res.status(404).json({ error: "not_found" });
    setAudioHeaders(res, stat, metaInfo);
    fs.createReadStream(blob).pipe(res);
  } catch (err) {
    console.error("audio fetch failed", err);
    res.status(500).json({ error: "fetch_failed" });
  }
});

app.delete("/api/audio/:id", async (req, res) => {
  try {
    const { blob, meta } = audioPaths(req.params.id);
    await fsp.unlink(blob).catch(() => {});
    await fsp.unlink(meta).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("audio delete failed", err);
    res.status(500).json({ error: "delete_failed" });
  }
});

// --- multer error handler ---------------------------------------------------
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: "upload_error", code: err.code });
  }
  next(err);
});

// --- static frontend --------------------------------------------------------
// The whole project root is served as static, EXCLUDING the server folder
// itself and the deploy script. We rely on Nginx (in production) to mount this
// app under /sop/, so all relative paths like script.js, styles.css just work.
app.use(
  express.static(ROOT, {
    index: "index.html",
    setHeaders(res, filePath) {
      // Force fresh HTML so users always see the deployed version after a reload.
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }),
);

// --- start ------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`AICP SOP console listening on http://${HOST}:${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
  if (ADMIN_TOKEN) console.log("ADMIN_TOKEN is set; /api/reset is protected.");
});
