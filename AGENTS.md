# AGENTS.md — quick reference for AI collaborators

This file is the fast on-ramp when an AI assistant (claude / codex / etc.) starts a session in this repo. For the full picture, read [`HANDOFF.md`](./HANDOFF.md) and [`server/README.md`](./server/README.md).

## Repo layout

```
SOP/
├─ console/                    ← this folder, the deployable webapp + backend
│  ├─ index.html               ← single-page UI
│  ├─ script.js                ← all frontend logic, ~2000 lines
│  ├─ styles.css
│  ├─ assets/                  ← gitignored. Mindmaps + downloadable source files (rsynced by deploy.sh)
│  ├─ server/                  ← Node + Express backend
│  │  ├─ server.js
│  │  ├─ import-state.mjs      ← merge JSON snapshots into shared state by id
│  │  ├─ data/                 ← gitignored. state.json + uploads/* + videos/*
│  │  └─ *-scenes.json         ← migration snapshots for re-import
│  ├─ deploy.sh                ← rsync + remote npm install + systemctl restart
│  ├─ HANDOFF.md               ← architecture, security model, working agreement
│  ├─ CHANGELOG.md
│  └─ README.md
└─ kb/                         ← OUTSIDE the repo. Source 装维 materials (docx/pptx/xlsx + extracted .txt)
   └─ 苏州移动装维资料/
```

The deployable webapp lives only in `console/`. `kb/` (sibling of `console/`) holds the raw source materials we curated into the 装维知识库 module — read it for context, but the webapp loads its own copy from `console/assets/source/装维资料/`.

## What lives where in `script.js`

| Concern | Function |
| --- | --- |
| App boot | `bootstrap()` → `hydrateFromServer()` → `applyServerState()` |
| Polling for shared state | `pollForUpdates()`, every `POLL_INTERVAL_MS` (4s) |
| Save path | form submit → `saveState()` → `pushStateToServer()` → `mergeStates()` on 409 |
| Scene type codes | `SCENE_TYPE_CODES` constant, top of file |
| Default dictionaries | `initialDictionaries`, top of file |
| Default seed scenes | `initialData.scenes`, top of file (only used as fallback when server returns empty) |
| 装维知识库 tab switching | `initKbTabs()`, called from `initEvents()` |

## What lives where in `index.html`

| Concern | Anchor |
| --- | --- |
| Left nav | `<aside class="sidebar">` |
| Scene list page | `<section id="scenes">` (includes `.naming-legend`) |
| 装维知识库 page | `<section id="mindmap">` with 8 `[data-kb-pane]` panes |
| Drill schedule | `<section id="schedule">` |
| Audio / records / issues | `<section id="records">`, `<section id="audio">`, `<section id="issues">` |

## Common tasks

### Add a scene type

1. Append to `initialDictionaries.sceneTypes` in `script.js`.
2. Add the code mapping to `SCENE_TYPE_CODES`.
3. Update the `.naming-legend` div in `index.html` (so users see the new code).
4. Land the dictionary update on the server: write a small JSON `{ "dictionaries": { "sceneTypes": [ ...new list... ] } }` and run `node server/import-state.mjs that.json http://47.102.216.22/sop`.
5. Update [`HANDOFF.md`](./HANDOFF.md) "Scene type expansion" table.

### Add scenes

1. Pick the next free seq for the relevant `[KB-]<TYPE>-NNN` prefix (current ranges in HANDOFF.md "Scene ID naming rule").
2. Write a JSON file under `server/`:
   ```json
   { "scenes": [ { "id": "KB-XX-NNN", "type": "...", "target": "...", "description": "...", "audioName": "...", "keywords": "...", "dataNeeded": "...", "devSupport": "...", "owner": "...", "status": "未开始", "note": "...", "tags": "...", "relatedScenes": "" } ] }
   ```
3. `cd server && node import-state.mjs <file>.json http://47.102.216.22/sop`.
4. Verify with `curl -s http://47.102.216.22/sop/api/state | python3 -m json.tool | head` (look for the new IDs).
5. Commit the JSON file alongside any code changes; commit message should mention the scene IDs added.

### Add a 装维知识库 tab

1. Add `<button class="kb-tab" data-kb-tab="<id>">…</button>` to the tabs row in `index.html`.
2. Add `<div class="kb-pane" data-kb-pane="<id>">…</div>` with content cards.
3. No JS change needed — `initKbTabs()` is data-attribute driven.
4. Test locally: `cd server && PORT=3091 node server.js`, open http://127.0.0.1:3091/, click the new tab.

### Deploy + verify

```bash
cd console
SSHPASS='<password>' ./deploy.sh
# verify
curl -s http://47.102.216.22/sop/api/state/version
```

## Hard rules

These come from past incidents — don't relax them.

- **Never put non-empty defaults in `initialData.records / audio / issues`.** They get silently pushed to canonical state. Demo data goes through `import-state.mjs`.
- **Never trust uploaded `Content-Type`.** Allowlist on POST, force canonical type + `nosniff` on GET. The smoke tests guard this.
- **Never commit `.aicp-admin-token`.** It's gitignored. The systemd unit on the server holds the canonical copy.
- **Never bypass `withStateLock(...)`** when adding a new write path on the server, or you'll lose writes.
- **Never push to `main` without running `smoke-test.mjs`** if you touched `server/` or upload code.
- **Naming rule is enforced socially, not by code.** Cross-check the next seq before assigning a new ID.

## Two-AI workflow (claude + codex)

- `git pull --rebase` before each editing session; the other assistant may have just pushed.
- One commit per logical change. UI tweaks separate from data migrations.
- Big additions: add a row to [`HANDOFF.md`](./HANDOFF.md)'s "Recent changes" table and a section to [`CHANGELOG.md`](./CHANGELOG.md).
- When you delete data on prod, include the exact commands and pre-deletion `version` number in the commit message so the other assistant can recover from `data.bak.*`.
- Production URL: <http://47.102.216.22/sop/>. Always verify changes there after deploy.
