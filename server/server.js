"use strict";

/**
 * AICP SOP Console - shared backend.
 *
 * Responsibilities:
 *  - Persist a single shared `state` object (the same shape the frontend already uses).
 *  - Store uploaded .mp3 audio blobs, .mp4 video blobs, and KB files on disk.
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
 *   - data/videos/<audioId>.mp4        (binary)
 *   - data/videos/<audioId>.meta.json  (originalName, mime, size, uploadedAt)
 *   - data/kb-files/manifest.json      (uploaded knowledge-base files)
 *   - data/kb-files/<fileId>.<ext>      (binary/text source file)
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
const VIDEO_DIR = path.join(DATA_DIR, "videos");
const KB_FILE_DIR = path.join(DATA_DIR, "kb-files");
const KB_SOURCE_DIR = path.join(ROOT, "assets", "source", "装维资料");
const KB_SOURCE_TEXT_DIR = path.join(KB_SOURCE_DIR, "extracted_text");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STATE_TMP = path.join(DATA_DIR, "state.json.tmp");
const KB_MANIFEST_FILE = path.join(KB_FILE_DIR, "manifest.json");
const KB_MANIFEST_TMP = path.join(KB_FILE_DIR, "manifest.json.tmp");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const BODY_LIMIT = process.env.BODY_LIMIT || "20mb";
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 50);
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 300);
const MAX_KB_FILE_MB = Number(process.env.MAX_KB_FILE_MB || 80);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // optional: required for /api/reset

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(KB_FILE_DIR, { recursive: true });

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

let kbFileChain = Promise.resolve();
function withKbFileLock(fn) {
  const next = kbFileChain.then(fn, fn);
  kbFileChain = next.catch(() => {});
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

function videoPaths(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_\-]/g, "");
  if (!safe) throw new Error("invalid video id");
  return {
    blob: path.join(VIDEO_DIR, `${safe}.mp4`),
    meta: path.join(VIDEO_DIR, `${safe}.meta.json`),
    safeId: safe,
  };
}

function sanitizeFileName(rawName, fallback = "knowledge-file") {
  const safe = String(rawName || fallback)
    .replace(/[\\/\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return safe || fallback;
}

// Allowed mime types on upload. Anything else is rejected to keep the
// served content from ever being interpreted as HTML/JS by the browser
// (which would be stored XSS on the same origin).
const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "application/octet-stream", // some browsers send this for .mp3
]);
const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4",
  "application/mp4",
  "application/octet-stream", // some browsers send this for .mp4
]);

const KB_FILE_TYPES = new Map([
  [".pdf", { mimeType: "application/pdf", previewKind: "pdf" }],
  [".png", { mimeType: "image/png", previewKind: "image" }],
  [".jpg", { mimeType: "image/jpeg", previewKind: "image" }],
  [".jpeg", { mimeType: "image/jpeg", previewKind: "image" }],
  [".webp", { mimeType: "image/webp", previewKind: "image" }],
  [".txt", { mimeType: "text/plain; charset=utf-8", previewKind: "text" }],
  [".md", { mimeType: "text/markdown; charset=utf-8", previewKind: "text" }],
  [".csv", { mimeType: "text/csv; charset=utf-8", previewKind: "text" }],
  [".doc", { mimeType: "application/msword", previewKind: "office" }],
  [".docx", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", previewKind: "office" }],
  [".xls", { mimeType: "application/vnd.ms-excel", previewKind: "office" }],
  [".xlsx", { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", previewKind: "office" }],
  [".ppt", { mimeType: "application/vnd.ms-powerpoint", previewKind: "office" }],
  [".pptx", { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", previewKind: "office" }],
]);

const BLOCKED_KB_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
]);

// Defense-in-depth headers attached to every blob response so even if
// content-type inference were wrong, the browser will refuse to sniff
// or execute the body as a document.
function applyBlobSafetyHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Referrer-Policy", "no-referrer");
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
    // also wipe uploaded media and maintained KB files
    await Promise.all(
      [UPLOAD_DIR, VIDEO_DIR, KB_FILE_DIR].map(async (dir) => {
        const entries = await fsp.readdir(dir).catch(() => []);
        await Promise.all(entries.map((name) => fsp.unlink(path.join(dir, name)).catch(() => {})));
      }),
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

const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
});

app.post("/api/audio/:id", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  if (!ALLOWED_AUDIO_MIME.has(req.file.mimetype)) {
    return res.status(415).json({ error: "unsupported_media_type", mimetype: req.file.mimetype });
  }
  try {
    const { blob, meta, safeId } = audioPaths(req.params.id);
    const rawName = req.body.fileName || req.file.originalname || `${safeId}.mp3`;
    // Strip path separators / control chars from the stored filename — this
    // is what we echo back in Content-Disposition.
    const fileName = String(rawName).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200);
    const size = req.file.size;
    const uploadedAt = new Date().toISOString();
    const checksum = crypto
      .createHash("sha1")
      .update(req.file.buffer)
      .digest("hex");

    await fsp.writeFile(blob, req.file.buffer);
    await fsp.writeFile(
      meta,
      // Note: mimeType is the canonical "audio/mpeg" — we do NOT trust the
      // client-supplied value, since this header is later set on responses.
      JSON.stringify({ id: safeId, fileName, mimeType: "audio/mpeg", size, uploadedAt, checksum }, null, 2),
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
  // Always force the canonical mime type — never echo what the uploader
  // sent. Combined with nosniff this neutralises stored-XSS via mime swap.
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  applyBlobSafetyHeaders(res);
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

// --- API: video --------------------------------------------------------------
app.post("/api/video/:id", uploadVideo.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  if (!ALLOWED_VIDEO_MIME.has(req.file.mimetype)) {
    return res.status(415).json({ error: "unsupported_media_type", mimetype: req.file.mimetype });
  }
  try {
    const { blob, meta, safeId } = videoPaths(req.params.id);
    const rawName = req.body.fileName || req.file.originalname || `${safeId}.mp4`;
    const fileName = String(rawName).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200);
    const size = req.file.size;
    const uploadedAt = new Date().toISOString();
    const checksum = crypto
      .createHash("sha1")
      .update(req.file.buffer)
      .digest("hex");

    await fsp.writeFile(blob, req.file.buffer);
    await fsp.writeFile(
      meta,
      // mimeType is canonicalised; client-supplied value is ignored on response.
      JSON.stringify({ id: safeId, fileName, mimeType: "video/mp4", size, uploadedAt, checksum }, null, 2),
      "utf8",
    );
    res.json({ id: safeId, fileName, size, uploadedAt, checksum });
  } catch (err) {
    console.error("video upload failed", err);
    res.status(500).json({ error: "upload_failed" });
  }
});

async function videoFileInfo(id) {
  const { blob, meta } = videoPaths(id);
  let metaInfo = null;
  try {
    metaInfo = JSON.parse(await fsp.readFile(meta, "utf8"));
  } catch {}
  const stat = await fsp.stat(blob).catch(() => null);
  return { blob, metaInfo, stat };
}

function setVideoHeaders(res, stat, metaInfo) {
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  applyBlobSafetyHeaders(res);
  if (metaInfo?.checksum) res.setHeader("X-Video-Checksum", metaInfo.checksum);
  if (metaInfo?.fileName) {
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(metaInfo.fileName)}`,
    );
  }
}

app.head("/api/video/:id", async (req, res) => {
  try {
    const { metaInfo, stat } = await videoFileInfo(req.params.id);
    if (!stat) return res.sendStatus(404);
    setVideoHeaders(res, stat, metaInfo);
    res.status(200).end();
  } catch (err) {
    console.error("video head failed", err);
    res.sendStatus(500);
  }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    const { blob, metaInfo, stat } = await videoFileInfo(req.params.id);
    if (!stat) return res.status(404).json({ error: "not_found" });
    setVideoHeaders(res, stat, metaInfo);
    fs.createReadStream(blob).pipe(res);
  } catch (err) {
    console.error("video fetch failed", err);
    res.status(500).json({ error: "fetch_failed" });
  }
});

app.delete("/api/video/:id", async (req, res) => {
  try {
    const { blob, meta } = videoPaths(req.params.id);
    await fsp.unlink(blob).catch(() => {});
    await fsp.unlink(meta).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("video delete failed", err);
    res.status(500).json({ error: "delete_failed" });
  }
});

// --- API: knowledge-base files ----------------------------------------------
const uploadKbFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_KB_FILE_MB * 1024 * 1024 },
});

async function readKbManifest() {
  try {
    const raw = await fsp.readFile(KB_MANIFEST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
      return { files: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return { files: [] };
    throw err;
  }
}

async function writeKbManifestAtomically(manifest) {
  await fsp.writeFile(KB_MANIFEST_TMP, JSON.stringify(manifest, null, 2), "utf8");
  await fsp.rename(KB_MANIFEST_TMP, KB_MANIFEST_FILE);
}

function kbFileStoragePath(file) {
  const safeId = String(file?.id || "").replace(/[^A-Za-z0-9_\-]/g, "");
  const ext = String(file?.extension || "").toLowerCase();
  if (!safeId || !KB_FILE_TYPES.has(ext)) throw new Error("invalid kb file");
  return path.join(KB_FILE_DIR, `${safeId}${ext}`);
}

function publicKbFile(file) {
  return {
    id: file.id,
    source: file.source || "managed",
    fileName: file.fileName,
    extension: file.extension,
    mimeType: file.mimeType,
    previewKind: file.previewKind,
    size: file.size,
    checksum: file.checksum,
    uploadedAt: file.uploadedAt,
  };
}

async function listKbSourceFiles() {
  const entries = await fsp.readdir(KB_SOURCE_DIR, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    const extension = path.extname(fileName).toLowerCase();
    const type = KB_FILE_TYPES.get(extension);
    if (!type) continue;
    const originalPath = path.join(KB_SOURCE_DIR, fileName);
    const textPath = path.join(KB_SOURCE_TEXT_DIR, `${fileName}.txt`);
    const [stat, textStat] = await Promise.all([
      fsp.stat(originalPath).catch(() => null),
      fsp.stat(textPath).catch(() => null),
    ]);
    if (!stat) continue;
    const hasTextPreview = Boolean(textStat);
    files.push({
      id: `SRC-${crypto.createHash("sha1").update(fileName).digest("hex").slice(0, 16)}`,
      source: "builtin",
      fileName,
      extension,
      mimeType: type.mimeType,
      previewKind: hasTextPreview && type.previewKind === "office" ? "text" : type.previewKind,
      originalPreviewKind: type.previewKind,
      size: stat.size,
      checksum: "",
      uploadedAt: stat.mtime.toISOString(),
      builtinPath: originalPath,
      textPreviewPath: hasTextPreview ? textPath : "",
    });
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-CN"));
}

async function findKbSourceFile(id) {
  const files = await listKbSourceFiles();
  return files.find((file) => file.id === id) || null;
}

async function findKbFile(id) {
  const safeId = String(id || "").replace(/[^A-Za-z0-9_\-]/g, "");
  if (!safeId) return null;
  if (safeId.startsWith("SRC-")) return findKbSourceFile(safeId);
  const manifest = await readKbManifest();
  return manifest.files.find((file) => file.id === safeId) || null;
}

function setKbFileHeaders(res, file, disposition) {
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  if (file.checksum) res.setHeader("X-KB-File-Checksum", file.checksum);
  applyBlobSafetyHeaders(res);
}

app.get("/api/kb-files", async (_req, res) => {
  try {
    const [manifest, sourceFiles] = await Promise.all([readKbManifest(), listKbSourceFiles()]);
    const managedFiles = manifest.files
      .slice()
      .sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")))
      .map(publicKbFile);
    const files = [...sourceFiles.map(publicKbFile), ...managedFiles];
    res.json({ files });
  } catch (err) {
    console.error("kb files list failed", err);
    res.status(500).json({ error: "list_failed" });
  }
});

app.post("/api/kb-files", uploadKbFile.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  const fileName = sanitizeFileName(req.body.fileName || req.file.originalname, "knowledge-file");
  const extension = path.extname(fileName).toLowerCase();
  const type = KB_FILE_TYPES.get(extension);
  if (!type) {
    return res.status(415).json({ error: "unsupported_file_type", extension });
  }
  if (BLOCKED_KB_MIME.has(req.file.mimetype)) {
    return res.status(415).json({ error: "unsupported_media_type", mimetype: req.file.mimetype });
  }

  try {
    const saved = await withKbFileLock(async () => {
      const manifest = await readKbManifest();
      const id = `KBF-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const uploadedAt = new Date().toISOString();
      const checksum = crypto.createHash("sha1").update(req.file.buffer).digest("hex");
      const file = {
        id,
        fileName,
        extension,
        mimeType: type.mimeType,
        previewKind: type.previewKind,
        size: req.file.size,
        checksum,
        uploadedAt,
      };
      await fsp.writeFile(kbFileStoragePath(file), req.file.buffer);
      manifest.files = [file, ...manifest.files.filter((item) => item.id !== id)];
      await writeKbManifestAtomically(manifest);
      return file;
    });
    res.json(publicKbFile(saved));
  } catch (err) {
    console.error("kb file upload failed", err);
    res.status(500).json({ error: "upload_failed" });
  }
});

app.get("/api/kb-files/:id/download", async (req, res) => {
  try {
    const file = await findKbFile(req.params.id);
    if (!file) return res.status(404).json({ error: "not_found" });
    const blob = file.source === "builtin" ? file.builtinPath : kbFileStoragePath(file);
    const stat = await fsp.stat(blob).catch(() => null);
    if (!stat) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Length", stat.size);
    setKbFileHeaders(res, file, "attachment");
    fs.createReadStream(blob).pipe(res);
  } catch (err) {
    console.error("kb file download failed", err);
    res.status(500).json({ error: "download_failed" });
  }
});

app.get("/api/kb-files/:id/preview", async (req, res) => {
  try {
    const file = await findKbFile(req.params.id);
    if (!file) return res.status(404).json({ error: "not_found" });
    if (!["image", "pdf", "text"].includes(file.previewKind)) {
      return res.status(415).json({ error: "preview_not_supported", previewKind: file.previewKind });
    }
    const blob = file.source === "builtin" && file.textPreviewPath
      ? file.textPreviewPath
      : file.source === "builtin"
        ? file.builtinPath
        : kbFileStoragePath(file);
    const stat = await fsp.stat(blob).catch(() => null);
    if (!stat) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Length", stat.size);
    setKbFileHeaders(
      res,
      file.textPreviewPath ? { ...file, mimeType: "text/plain; charset=utf-8" } : file,
      "inline",
    );
    fs.createReadStream(blob).pipe(res);
  } catch (err) {
    console.error("kb file preview failed", err);
    res.status(500).json({ error: "preview_failed" });
  }
});

app.delete("/api/kb-files/:id", async (req, res) => {
  try {
    if (String(req.params.id || "").startsWith("SRC-")) {
      return res.status(403).json({ error: "builtin_file_cannot_be_deleted" });
    }
    const deleted = await withKbFileLock(async () => {
      const manifest = await readKbManifest();
      const file = manifest.files.find((item) => item.id === req.params.id);
      manifest.files = manifest.files.filter((item) => item.id !== req.params.id);
      if (file) await fsp.unlink(kbFileStoragePath(file)).catch(() => {});
      await writeKbManifestAtomically(manifest);
      return file;
    });
    res.json({ ok: true, deleted: Boolean(deleted) });
  } catch (err) {
    console.error("kb file delete failed", err);
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
  console.log(`Video dir: ${VIDEO_DIR}`);
  if (ADMIN_TOKEN) console.log("ADMIN_TOKEN is set; /api/reset is protected.");
});
