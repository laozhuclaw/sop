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
| `f5b8131` (2026-05-10) | **装维知识库 module + scene type expansion**. See "装维知识库 + 场景体系" section below. |
| pending (2026-05-10) | **Knowledge-base file maintenance**: unified built-in + uploaded file list via `/api/kb-files`; uploaded files persist in `server/data/kb-files/`. |
| pending (2026-05-10) | **穿越日程同步 AICP-01.xlsx**: rewrote `AICP_SCHEDULE_ROWS` and `defaultUsers` from the spreadsheet; replaced 10 photos in `assets/schedule/`; added `server/schedule-aicp-01.json` for `import-state.mjs`. |
| pending (2026-05-10) | **Terminology**: every user-facing "演练" renamed to "穿越" (nav + hero + dictionary statuses/labels + form labels). Historical CHANGELOG entries left untouched. |

`HANDOFF.md` (this file) is the fresh part.

## 装维知识库 + 场景体系（2026-05-10）

This is the largest functional addition since the original migration. Read this before touching `#mindmap` (now 装维知识库), the scene list, or the dictionary.

### Source materials

Original 装维 (Suzhou Mobile installation/maintenance) source files live OUTSIDE this repo, in the sibling directory:

```
/Users/zhujmac/AICP/SOP/kb/苏州移动装维资料/   (renamed from web/ on 2026-05-10)
├─ *.docx / *.pptx / *.xlsx / *.pdf / *.png   ← raw materials
├─ extracted_text/*.txt                       ← Python-extracted plaintext for grepping
├─ 装维资料学习摘要.md                          ← curated summary
└─ ...
```

The website does **not** read from `kb/` at runtime. We copied the originals into `console/assets/source/装维资料/` so users can download them from the "资料原文" tab. If new materials arrive in `kb/`, copy the files into `assets/source/装维资料/` and add a `<li>` in `index.html` under the `kb-pane[data-kb-pane="source"]` block.

`assets/` is gitignored (28 MB of binaries) — `deploy.sh` rsyncs them to prod separately.

### 装维知识库 module (`#mindmap` view)

Single mindmap was replaced with 8 tabs in `index.html`:

| `data-kb-pane` | Content | Anchor card class |
| --- | --- | --- |
| `mindmaps` | Original mindmap PNGs | `kb-card` |
| `workflow` | Morning brief → 入户前 → 作业中 → 出户前 → 出户后 | `kb-stage` |
| `morning` | 工装/工具/四必讲/六严禁/登高五必做/一级风险源/etc. | `kb-card` |
| `fault` | 5 fault diagnosis paths | `kb-fault` |
| `scripts` | 17 script cards (开口/FTTR/异议/四看) | `kb-card` |
| `tools` | 12 troubleshoot tool cards with code blocks | `kb-tool` |
| `iphone` | iPhone Wi-Fi setup guide | `kb-card` |
| `source` | Download links for raw materials | `<ul>` |

Tab switching is `initKbTabs()` in `script.js`. Styles live under `/* ===== 装维知识库 ===== */` in `styles.css`.

The "资料原文" tab is now driven by `/api/kb-files`:

- **内置资料**: static copies under `assets/source/装维资料/`, shipped by `deploy.sh`. Images/PDF preview from the original file; Word/Excel/PPT preview through extracted text files in `assets/source/装维资料/extracted_text/`.
- **维护上传**: runtime-managed files uploaded through `/api/kb-files`. Files and `manifest.json` live in `server/data/kb-files/`, so they are persistent and excluded from deploy overwrite. Browser preview is supported for images, PDF, TXT, Markdown, and CSV; uploaded Office formats remain downloadable unless a text preview pipeline is added later.

Allowed KB upload extensions are `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`,
`.txt`, `.md`, `.csv`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`.
The server blocks HTML/SVG/JS uploads, forces canonical response
`Content-Type`, and applies `nosniff`/sandbox headers on preview/download.

### Scene type expansion

`initialDictionaries.sceneTypes` now keeps only the knowledge-base scene types used by `KB-*` scenes.

| Code | Type | Purpose |
| --- | --- | --- |
| `SX` | 随销 | Cross-selling drill |
| `LC` | 装维流程 | Workflow SOP scenes (new) |
| `GZ` | 故障诊断 | Fault diagnosis SOP scenes (new) |
| `TS` | 投诉预处理 | Complaint pre-processing tools (new) |

A constant `SCENE_TYPE_CODES` near the top of `script.js` maps codes ↔ Chinese names. Keep them in sync if you add a type.

### Scene ID naming rule

```
KB-<2-letter type>-<3-digit seq>
```

- `KB-` prefix is mandatory for all maintained scene ids. Legacy drill ids (`BZ-*`, `FW-*`, `SX-*`, `YC-*`) were removed from the shared scene list and dropdowns.
- Examples: `KB-LC-001` (workflow), `KB-SX-005` (cross-selling).
- The same legend is rendered in the 场景清单 page header (`.naming-legend` div) so users see it.
- When adding scenes, **check the next free seq for that prefix** — IDs are not auto-generated. As of 2026-05-10:
  - `KB-SX-001..013`, `KB-LC-001..005`, `KB-GZ-001..005`, `KB-TS-001..004`

### Data import scripts

Two JSON snapshots live in `server/`. They're for replaying the 2026-05-10 KB migration; running them again is idempotent (merge by id):

| File | Contents |
| --- | --- |
| `server/kb-scenes.json` | 13 随销 KB scenes (KB-SX-001..013) |
| `server/kb-scenes-v2.json` | 14 流程/故障/投诉 KB scenes (KB-LC/GZ/TS) **plus** `dictionaries.sceneTypes` update |

Use `import-state.mjs` to apply (it fetches current version, merges by id, PUTs):

```bash
cd server
node import-state.mjs <file.json> http://47.102.216.22/sop
# default base is http://127.0.0.1:3000 if you omit the URL
```

The import script merges by id for `scenes / records / audio / issues` and shallow-merges `dictionaries`. Add new entity types to its merge loop if you add new top-level keys.

### Production state checkpoint (2026-05-10)

- Version: 45+
- Total scenes: 27 (`KB-SX` 13 / `KB-LC` 5 / `KB-GZ` 5 / `KB-TS` 4)
- Legacy drill scene ids (`BZ-*`, `FW-*`, `SX-*`, `YC-*`) were removed from scenes, related-scene links, schedules, and sample audio rows.


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
- The 装维知识库 view body is in `index.html` under
  `<section id="mindmap" class="view" data-view="mindmap">`. Tab content
  panes are `[data-kb-pane="<id>"]`. The tab switching logic is
  `initKbTabs()` near the bottom of `script.js`, called from `initEvents()`.
- Scene ID naming legend is the `.naming-legend` div inside
  `<section id="scenes">` in `index.html`. Update both the legend and
  `SCENE_TYPE_CODES` (top of `script.js`) when you add a type.

## Working agreement (codex + claude)

When two AI assistants share this codebase:

1. **Always pull before editing.** `git pull --rebase` from the relevant
   subdir; the other assistant may have just landed something.
2. **One commit per logical change.** Don't bundle UI tweaks with data
   migrations — it makes review harder for the other side.
3. **Run smoke tests after backend or upload changes.** The XSS-via-mimetype
   tests in `smoke-test.mjs` are the canary; never skip them.
4. **Document scene additions in `HANDOFF.md`'s checkpoint section.** Bump
   the version number, total count, and last-known-clean-state line.
5. **Never delete data without writing the deletion command into the
   commit message.** State is shared and recovery requires the prior
   `version` to roll back via the `data.bak.*` snapshots on the server.
6. **Naming rule is non-negotiable.** New scene IDs must match
   `KB-<2-letter type>-<3-digit seq>`. If you need a new type, extend
   `SCENE_TYPE_CODES`, the dictionary, the legend in `index.html`, AND
   land the dictionary update via `import-state.mjs` so existing browsers
   pick it up.
