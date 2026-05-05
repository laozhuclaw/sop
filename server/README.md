# AICP SOP Console — backend

Shared backend that turns the previously single-user (localStorage-only)
console into a multi-user one. All scenes / records / audio / issues live in
`server/data/` on the server; every browser polls the same endpoint, so
everyone sees each other's data within ~4 seconds.

## What changed in the frontend
- `state` now lives in `server/data/state.json` (atomic writes, JSON file).
- Audio `.mp3` files live in `server/data/uploads/` (plus a `.meta.json`
  sidecar with original name + size + checksum).
- The browser no longer uses IndexedDB for audio; it streams via
  `GET /api/audio/<id>`.
- `currentUser` (the logged-in person on this browser) is the only thing
  still kept in localStorage, on purpose — each device has its own login.
- Optimistic concurrency: every `PUT /api/state` carries `expectedVersion`.
  On a `409`, the frontend merges by entity id (local edits win) and retries.

## API surface
| Method | Path | Purpose |
| --- | --- | --- |
| `GET`    | `/api/state` | Full state + `version` + `updatedAt`. |
| `GET`    | `/api/state/version` | Cheap polling endpoint. |
| `PUT`    | `/api/state` | Body `{data, expectedVersion}`. 409 on stale. |
| `POST`   | `/api/audio/:id` | Multipart `file=...`. Saves blob + meta. |
| `GET`    | `/api/audio/:id` | Streams the blob. |
| `DELETE` | `/api/audio/:id` | Removes blob + meta. |
| `POST`   | `/api/reset` | Wipes state + uploads. Token-gated if `ADMIN_TOKEN` set. |

## Local development
```bash
cd server
npm install
PORT=3091 node server.js
# then open http://127.0.0.1:3091/
```

To run the smoke tests against a running server:
```bash
BASE=http://127.0.0.1:3091 node smoke-test.mjs
```

## First-time deploy on Aliyun

Assuming Aliyun Linux / CentOS / Ubuntu with root SSH on port 50022.

1. **Install Node 18+ on the server** (one-time):
   ```bash
   ssh -p 50022 root@47.102.216.22 'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs'
   # or for Ubuntu/Debian:
   # ssh ... 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs'
   ```

2. **Push files** from your laptop:
   ```bash
   ./deploy.sh
   ```
   This rsyncs the project, runs `npm install --omit=dev`, and (if the
   service exists) restarts it.

3. **Install the systemd unit** (one-time):
   ```bash
   ssh -p 50022 root@47.102.216.22
   cp /var/www/html/sop/server/aicp-sop.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now aicp-sop.service
   systemctl status aicp-sop.service
   ```

4. **Update Nginx** to proxy `/sop/` to Node. Replace any old `location`
   block that pointed at `/var/www/html/sop/` with the snippet in
   `nginx-sop.conf` (key piece: `proxy_pass http://127.0.0.1:3000/;`).
   ```bash
   cp /var/www/html/sop/server/nginx-sop.conf /etc/nginx/conf.d/sop.conf
   nginx -t && systemctl reload nginx
   ```

5. **Smoke test from your laptop**:
   ```bash
   curl http://47.102.216.22/sop/api/state
   ```
   Should return `{"data":{},"version":1,...}` on a fresh install.

6. **Verify multi-user**: open the URL in two different browsers (Chrome +
   Safari, or two incognito windows). Add a scene in one; within ~4s the
   other browser's "已同步" pill should bump and the table should refresh.

## Migrating existing browser data

Anyone who already filled data in localStorage:

1. In their browser, click **"导出 JSON"** at the top right.
2. Copy that JSON file to anyone with shell access.
3. Run:
   ```bash
   node server/import-state.mjs ~/Downloads/aicp-sop-training-...json http://47.102.216.22/sop
   ```
4. The script merges by entity id, so multiple people's exports can be
   imported one after another without losing each other's rows. Audio files
   are NOT migrated — re-upload them from the audio panel.

## Subsequent deploys (during a drill)

```bash
DRY_RUN=1 ./deploy.sh    # preview what will change
./deploy.sh              # apply
```

The script is idempotent and uses `accept-new` for host keys (first connect
pins, future connects fail loudly on key change — that is the point).

## Operational notes
- **Backups:** `cp -a server/data server/data.bak.$(date +%F-%H%M)` before risky changes.
- **Audio retention:** uploads are not auto-cleaned. Watch `du -sh server/data/uploads`.
- **Reset in production:** run `curl -X POST -H "X-Admin-Token: <token>" .../api/reset` —
  set `ADMIN_TOKEN` in the systemd unit first or anyone with the URL can wipe data.
- **Logs:** `journalctl -u aicp-sop -f`.
- **Port:** Node listens on 127.0.0.1:3000 by default. The public path is
  Nginx-only; the Node port should not be exposed to the internet.

## Known limitations (still TODO)
- No HTTPS yet. Add Let's Encrypt + redirect 80→443 before any real PII flows.
- No auth: anyone with the URL can read/write. Add Nginx Basic Auth or an
  IP allowlist before sharing the link broadly.
- "Last write wins" within a single entity (one person's edit clobbers
  another's edit on the *same* scene). Different entities are merge-safe.
- Reset endpoint is destructive and only protected by `ADMIN_TOKEN` if set.
