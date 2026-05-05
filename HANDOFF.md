# Handoff — AICP SOP Console

This doc is for whoever picks up this codebase next (likely codex). Read
it once before making changes; it captures the architecture, what was
just changed, and what NOT to do.

## TL;DR

- **Frontend**: vanilla HTML/CSS/JS in `index.html` / `script.js` / `styles.css`.
- **Backend**: Node + Express in `server/server.js`, single-file JSON state
  with optimistic versioning. Stores audio/video blobs on disk.
- **Live URL**: <http://47.102.216.22/sop/>. Single shared state across
  every browser; verified for ~16 simultaneous writers.
- **Deploy**: `SSHPASS='...' ./deploy.sh` from the project root. systemd
  unit `aicp-sop.service` already installed on the box.
- **Reset is now token-gated**. Token lives in the systemd unit only.
  See `server/README.md → Operational notes`.

## Architecture in 30 seconds

```
browser ───┐
browser ───┼──▶ Nginx :80 /sop/  ──▶ Node :3000  ──▶ data/state.json
browser ───┘                                       └─ data/uploads/<id>.mp3
                                                   └─ data/videos/<id>.mp4
```

- Every browser keeps its own `currentUser` in localStorage but everything
  else (scenes, records, audio metadata, issues, dictionaries, users) is
  on the server.
- Multi-day drill data is keyed by date in `dailySchedules` and
  `dailySummaries`; legacy `schedule` / `summary` remain as the
  2026-05-06 compatibility view.
- Every state write goes through `PUT /api/state` with
  `{data, expectedVersion}`. Mismatched versions get 409 with the
  server's current data; the frontend merges (id-keyed; local edits win
  per id) and retries. See `script.js → pushStateToServer / mergeStates`.
- Polls `/api/state/version` every 4s. If the version bumped while the
  user is editing a form/scene-card, the refresh is suppressed until
  they're done so we don't clobber in-flight typing.
- Audio blobs are streamed directly via `<audio src="/api/audio/<id>">`.
  No IndexedDB anymore; the blob lives on the server.

## Recent changes worth knowing about

| Commit | What it did |
| --- | --- |
| `5546a79` | Original migration from localStorage-only to shared backend (Express + multer + optimistic version protocol). |
| `846c1e9` … `2c61bd0` | Codex iteration: submitter field, sample data, people-list CRUD, mp4 video uploads, deploy fix. |
| `ba93e0f` | **Security hardening**: upload mimetype allowlist, force canonical Content-Type on response, `X-Content-Type-Options: nosniff` + CSP, sanitise stored filename. Closes a stored-XSS vector. Also empties `initialData.records/audio/issues` to stop sample-data from being silently re-uploaded into the canonical state. |
| `f49076c` | `.gitignore` for `.aicp-admin-token` and `server/data`. |
| pending after `b83d5ee` | Daily schedule + summary support via date-keyed shared state. |

`HANDOFF.md` (this file) is the fresh part.

## Running locally

```bash
cd server && npm install
PORT=3091 node server.js
# open http://127.0.0.1:3091/
```

## Tests (always run before pushing)

```bash
cd server
PORT=3091 node server.js &        # in another terminal
BASE=http://127.0.0.1:3091 node smoke-test.mjs                # 12 cases
BASE=http://127.0.0.1:3091 CLIENTS=8 PER_CLIENT=3 node concurrency-test.mjs
BASE=http://127.0.0.1:3091 CLIENTS=4 node upload-concurrency-test.mjs
```

The two stress tests use sentinel ids (`__C-*`, `__UP-*`) and clean up
after themselves, so they're safe to fire at production for confidence:

```bash
BASE=http://47.102.216.22/sop CLIENTS=16 PER_CLIENT=5 node concurrency-test.mjs
BASE=http://47.102.216.22/sop CLIENTS=8 node upload-concurrency-test.mjs
```

Last verified production results (16 clients × 5 entities × 4 kinds = 320
parallel writes): all 320 entities landed; 119 conflicts auto-resolved by
merge-retry; 9 seconds end-to-end. Upload contention test: 16 random-sized
blobs uploaded concurrently, all bytes verified, all cleaned up in ~4 sec.

## Deploy

From the project root:

```bash
SSHPASS='<aliyun root password>' ./deploy.sh
# or with key auth (preferred): ssh-copy-id, then leave SSHPASS unset
```

`./deploy.sh` rsyncs everything except `node_modules`, `server/data`,
`.git`, `.claude`, then on the remote runs `npm install --omit=dev` and
`systemctl restart aicp-sop`. Use `DRY_RUN=1 ./deploy.sh` to preview.

## Things that will save you a bad afternoon

1. **Never run `/api/reset` on prod casually.** It wipes scenes, records,
   audio, video, everything. It's now token-gated, but if you have the
   token, you still need to mean it. Take a backup first:
   ```bash
   ssh -p 50022 root@47.102.216.22 "cp -a /var/www/html/sop/server/data /var/www/html/sop/server/data.bak.\$(date +%F-%H%M)"
   ```
2. **Never put non-empty defaults in `initialData.records/audio/issues`.**
   `normalizeState()` falls back to those when the server returns `{}`,
   and the next save will silently push them to canonical state, polluting
   prod for everyone. Demo data goes through `server/import-state.mjs`.
3. **Don't trust uploaded `Content-Type`.** `req.file.mimetype` comes from
   the client. The upload handler must allowlist; the GET handler must
   force the canonical type and set `nosniff`. The smoke test asserts on
   this — if those tests fail, you've reintroduced the XSS hole.
4. **Don't break the version protocol.** `PUT /api/state` always validates
   `expectedVersion` against the on-disk version. If you add a new write
   path, route it through `withStateLock(...)` and bump the version
   exactly the same way `PUT` does, otherwise you'll lose writes.
5. **The local laptop must keep `.aicp-admin-token` (chmod 600).** It's
   gitignored. Don't commit it. The systemd unit on the server is the
   only other place it should exist. If it leaks, regenerate
   (`openssl rand -hex 24`) and redeploy.

## Open work (in rough priority order)

1. **Auth on writes**: `/api/state` PUT, `/api/audio/*` POST/DELETE,
   `/api/video/*` POST/DELETE are still un-authenticated. A Basic Auth
   on Nginx or a simple shared `X-Api-Token` would cover this.
2. **Switch video uploads to `multer.diskStorage()`** — the current
   memoryStorage path holds the whole 300 MB body in Node heap.
3. **Clear `defaultUsers` in `script.js`** of real names/phones and rely
   on the runtime people-list table.
4. **HTTPS on Aliyun** (Let's Encrypt + redirect 80→443).
5. **Soft-delete for users/scenes** so accidental deletes are recoverable.
6. **Optional**: switch `state.json` to SQLite when the JSON file passes
   ~10 MB or write contention crosses ~30 simultaneous writers.

## Where to look first

- `script.js` is ~2000 lines, mostly UI rendering. The interesting paths:
  `bootstrap()` → `hydrateFromServer()` → `applyServerState()` →
  `pollForUpdates()` and the form-submit handlers in `initEvents()` that
  ultimately call `saveState()` → `pushStateToServer()`.
- `server/server.js` is one file, ~430 lines. Sections marked
  `// --- API: state ---`, `// --- API: audio ---`, `// --- API: video ---`.
- All long-running ops on the server go through `withStateLock(fn)`.
- The 4-second poll cadence is `POLL_INTERVAL_MS` near the top of
  `script.js`.
