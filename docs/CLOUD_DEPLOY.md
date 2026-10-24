# Run Launchpad on one cloud server

Launchpad can run as a single Node process. That process serves the API and the built React app on one `PORT`. The shop PC does not use this path. On that PC the PowerShell script still starts the API on port 3000 and the Vite dev server on port 5173.

Do not commit `.env`, database files, or upload files. Set secrets in the host's environment.

## What you need

- A small Linux host with Docker, or a Render / Railway app that builds `Dockerfile`.
- A persistent disk. SQLite and local uploads disappear if they live only on the container filesystem.
- The current `launchpad.db` and the uploads folder from the Windows PC.
- DNS access for `launchpad.acgprinting.com`.
- `INIT_ADMIN_PASSWORD` only for a brand-new database. A copied database already has its admin user.

Optional, only if you use them today:

- SMTP values (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) for file-share and quote email.
- Microsoft 365 values (`M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, `M365_MAILBOX`) for Email Orders.
- S3-compatible credentials if you choose object storage instead of the disk for uploads. This stays off unless `FILE_STORAGE_DRIVER=s3`.

## Environment

Copy the names from `backend/.env.example`. For a single HTTPS service:

| Variable | Example | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | Serves `frontend/dist` and runs migrations on startup |
| `PORT` | set by the host | One public port |
| `DATABASE_PATH` | `/var/data/launchpad.db` | SQLite file on the persistent disk. Wins over `DATABASE_FILE` |
| `UPLOADS_DIR` | `/var/data/uploads` | Local upload folder on that disk. Wins over `UPLOAD_DIR` |
| `PUBLIC_APP_URL` | `https://launchpad.acgprinting.com` | Links in email |
| `TRUST_PROXY` | `1` | The HTTPS proxy's client IP is used for rate limits |
| `DELIVERY_TIMEZONE` | `America/New_York` | Same shop clock as the PC |
| `INIT_ADMIN_PASSWORD` | choose one | Used only when the admin user does not exist yet |
| `BACKUP_ENABLED` | `false` until you want it | Nightly SQLite online backup |

`CORS_ORIGINS` can stay unset. The browser loads the app and the API from the same host. Production does not allow `http://localhost:5173` unless you list it in `CORS_ORIGINS`. Development still allows the Vite origins. Sign-in uses the bearer token in the browser. The server does not set a session cookie. `COOKIE_SECURE` is unused.

Leave `FILE_STORAGE_DRIVER` unset or set it to `local` to keep files on `UPLOADS_DIR`. Production creates that absolute folder at startup. Development on the PC does not.

On startup in production the process runs `node init_db.js` before it listens. That applies the same idempotent migrations and seeds as a manual init. It does not reset an existing admin password. A sample work order is inserted again only when its number, such as `WO-1001`, is not already in the database.

## Build and run

From the repository root, which is also what the Docker image does:

```bash
npm run build
NODE_ENV=production npm start
```

`npm run build` installs the frontend and writes `frontend/dist`. `npm start` runs `node backend/server.js`.

`Dockerfile` builds that image and runs it as the `node` user (uid 1000). `render.yaml` is a Render blueprint: one web service, health check `/health`, and a 10 GB disk mounted at `/var/data`. The disk must be writable by uid 1000. On a VM, `sudo chown -R 1000:1000 /var/data` before the first start.

### Render

1. Push the repository to the Git remote Render can see.
2. New Blueprint, or a new Web Service with runtime Docker and `Dockerfile` at the repository root.
3. Attach a persistent disk at `/var/data`.
4. Set the environment from the table above. Put `INIT_ADMIN_PASSWORD`, SMTP, and Microsoft 365 values in the dashboard, not in git.
5. Deploy. The first boot migrates the database. Open `/health` and expect `{ "status": "ok" }`.
6. Open the service URL and sign in.

### Railway or a DigitalOcean droplet

Use the same image and the same variables.

- Railway: add a volume mounted at `/var/data`. Railway sets `PORT`. Set `TRUST_PROXY=1`.
- DigitalOcean droplet: install Docker, create a directory such as `/var/launchpad` on the droplet's disk (or a Volume mounted at `/var/data`), and run:

```bash
docker build -t launchpad .
docker run -d --name launchpad --restart unless-stopped \
  -p 3000:3000 \
  -v /var/data:/var/data \
  -e NODE_ENV=production \
  -e DATABASE_PATH=/var/data/launchpad.db \
  -e UPLOADS_DIR=/var/data/uploads \
  -e PUBLIC_APP_URL=https://launchpad.acgprinting.com \
  -e TRUST_PROXY=1 \
  -e DELIVERY_TIMEZONE=America/New_York \
  launchpad
```

Put a TLS proxy (Caddy or the droplet's load balancer) in front of port 3000. The app does not terminate TLS itself.

## Copy the data off the Windows PC

Do this while people can still use the PC, then do it once more at cutover.

1. Stop the Launchpad backend on the PC so SQLite is not in the middle of a write. The dev script's API window is the one to close.
2. Copy the database file. With the example env, that is `backend/database/launchpad.db` when the API was started from `backend/`. If `DATABASE_FILE` points somewhere else, copy that file. Copy the `-wal` and `-shm` files too if they are present, or stop the process and let SQLite checkpoint first.
3. Copy the uploads folder. That is the folder shown on System Settings, or `data/uploads` when no folder has been saved. Include the hidden `.launchpad-storage` file. Copy the files themselves (names like `abc123...pdf`), not a shortcut.
4. On the server, place the database at `DATABASE_PATH` (`/var/data/launchpad.db`) and the files inside `UPLOADS_DIR` (`/var/data/uploads`).

Rows in the database still name the Windows folder (`C:\...` or `Z:\...`). The Linux process will not open those paths until they are rewritten.

From `backend/` on a machine that can see the copied database and the copied uploads (the server is the easy place):

```bash
DATABASE_PATH=/var/data/launchpad.db UPLOADS_DIR=/var/data/uploads node scripts/relocate-storage.js
DATABASE_PATH=/var/data/launchpad.db UPLOADS_DIR=/var/data/uploads node scripts/relocate-storage.js --apply
```

The first command only prints counts. `--apply` points each file that exists in `UPLOADS_DIR` at that folder, writes the storage marker, and saves the folder in system settings. Files that were not copied stay listed as missing and are not given a new path.

Start the server after `--apply`. Sign in as the existing admin. The password is the one from the PC, not `INIT_ADMIN_PASSWORD`.

## S3-compatible uploads (optional)

Leave this off for the first cutover. Local files on the disk are the same model as the PC.

When you want the bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, or Backblaze B2):

```
FILE_STORAGE_DRIVER=s3
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_PREFIX=launchpad
```

- AWS: leave `S3_ENDPOINT` unset and set `S3_REGION` to the bucket region.
- Cloudflare R2: endpoint `https://<accountid>.r2.cloudflarestorage.com`, region `auto`.
- DigitalOcean Spaces: endpoint `https://<region>.digitaloceanspaces.com`, region such as `nyc3`.
- Backblaze B2: endpoint `https://s3.<region>.backblazeb2.com`, region such as `us-west-004`.

`S3_FORCE_PATH_STYLE` defaults to true when `S3_ENDPOINT` is set. The key needs `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on that bucket. New uploads stream to the bucket. Downloads stream back. Existing files stay on disk until you copy them and switch the driver. Keep a disk for `launchpad.db` either way.

## Nightly backup (optional)

`BACKUP_ENABLED` is false by default. Set it to `true` after the disk copy works.

The job uses SQLite's online backup API, so it does not copy a half-written file. It runs once each shop day, at or after `BACKUP_HOUR` (default 2) in `DELIVERY_TIMEZONE`. A restart later that day still catches up. It keeps `BACKUP_RETENTION_DAYS` files (default 14).

- Local storage: `/var/data/backups/launchpad-YYYYMMDD-HHMMSS.db`, the `backups` folder next to `launchpad.db`. That folder is not inside `UPLOADS_DIR`. Set `BACKUP_DIR` only when you want a different directory.
- S3 storage: the same file name under the bucket prefix `backups/`. The snapshot is streamed to the bucket.

A successful run stores `last_backup_at`. The admin board backup alert reads that value.

## DNS for launchpad.acgprinting.com

1. Deploy first and confirm the host's temporary URL loads the sign-in page over HTTPS.
2. At the DNS host for `acgprinting.com`, add a record for `launchpad`:
   - Render or Railway: CNAME `launchpad` to the hostname they show you. Do not CNAME the zone apex this way.
   - A droplet or load balancer: A record `launchpad` to that IPv4 address. Add AAAA if you have an IPv6 address.
3. In the host, add the custom domain `launchpad.acgprinting.com` and turn on its managed certificate.
4. Set `PUBLIC_APP_URL=https://launchpad.acgprinting.com` and redeploy so email links use that name.
5. Wait until `https://launchpad.acgprinting.com/health` returns `{ "status": "ok" }` and the certificate is valid.

## Cutover

1. Tell the shop that Launchpad will be read-only for a few minutes.
2. On the PC, stop the backend so no new orders or uploads are written.
3. Copy `launchpad.db` (and `-wal` / `-shm` if you did not checkpoint) and the uploads folder again, over the previous copy on the disk.
4. Run `node scripts/relocate-storage.js --apply` with `DATABASE_PATH` and `UPLOADS_DIR` set.
5. Start or restart the cloud process.
6. Sign in as admin. Open a recent order, download one file, and place a test order.
7. Point people at `https://launchpad.acgprinting.com`. Leave the PC copy stopped so the two databases do not diverge.

## Rollback

1. Point DNS back only if you changed it and the cloud service is unusable. TTL is often 5 to 30 minutes, so lower it the day before if you can.
2. Start the backend on the PC the way the PowerShell script always has (ports 3000 and 5173).
3. If any order was saved only on the server, copy that `launchpad.db` and any new files in `UPLOADS_DIR` back to the PC before starting the PC API, or those orders exist only on the server.
4. The PC keeps using `DATABASE_FILE` and `UPLOAD_DIR`. It does not read `DATABASE_PATH` unless you set that variable.

The cloud disk is still there after a rollback. You can fix the service and cut over again with a fresh copy.
