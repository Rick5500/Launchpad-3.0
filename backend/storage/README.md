# Storage drivers

Uploads, downloads, deletes, the orphan sweep, shared files, proofs, and inbound-email attachments all go through `backend/fileStore.js`. That module asks a storage driver to touch bytes. The driver in use is `local` unless `FILE_STORAGE_DRIVER=s3`.

`FILE_STORAGE_DRIVER` selects the driver. When it is unset, the local folder driver is used. `s3` stores bytes in an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, or Backblaze B2). Any other name fails with a clear error. The server keeps running. S3 stays off until `FILE_STORAGE_DRIVER` is set to `s3` and `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are set. See `backend/.env.example`.

## Local folder

`localFolder.js` stores each file in one folder on a filesystem the operating system can see. That folder can be a local disk, a mapped drive such as `Z:\launchpad`, or a network share such as `\\server\share\launchpad`. The folder is chosen in System Settings and stored in `system_settings.file_storage_dir`. When that key is empty, `UPLOAD_DIR` is used, then `data/uploads`.

The driver can create the final folder when its parent already exists, report free space, and write, read, and delete a file. Creating a folder an admin is saving, and the write/read/delete probe, run asynchronously with a timeout. Uploads do not create the folder. `fileStore` writes a `.launchpad-storage` marker when an admin saves the folder. On first start it also marks an existing `UPLOAD_DIR`, including one that is empty, so the first upload works. A missing `UPLOAD_DIR` is not created when it points somewhere other than the shipped default. Production mode (`NODE_ENV=production`) is the exception for an absolute `UPLOADS_DIR` or `UPLOAD_DIR`: that folder is created at startup so a mounted disk can be used. Development does not do that. When no folder is saved, the first start creates `data/uploads` once if no marker has been recorded for it, and creates the `data` parent when a fresh clone does not have it. `UPLOAD_DIR=../data/uploads` is that same default. A later start does not create that folder again. A saved folder is created only when an admin saves it. Restoring the database onto other disks means saving the folder again so the marker id matches that copy, or running `node scripts/relocate-storage.js --apply` after the files are copied into `UPLOADS_DIR`. See `docs/CLOUD_DEPLOY.md`. `fileStore` still rejects a stored name that is not a random id plus an allowed extension, and it still refuses a path that escapes the folder.

## S3-compatible bucket

`backend/storage/s3.js` stores each object under `S3_PREFIX` (default `launchpad`). Set `S3_ENDPOINT` for Cloudflare R2, DigitalOcean Spaces, or Backblaze B2. Leave it unset for AWS S3. `S3_FORCE_PATH_STYLE` defaults to on when an endpoint is set, which those three providers need. The System Settings folder is still the logical root used to name objects. Bytes for a new file go to the bucket, not to that folder. Uploads stream through `@aws-sdk/lib-storage` and downloads pipe the object body. Those calls are asynchronous, so they do not block the event loop. A missing bucket pauses uploads with HTTP 503 and does not stop the server. `node scripts/verify-cloud.js` checks this driver with an in-memory bucket and no network.

## OneDrive and SharePoint

A OneDrive or SharePoint driver is not included. To add one later, implement the same methods as the local driver (`status`, `ensureSync`, `checkNewFolder`, `probeSync`, `readMarkerSync`, `writeMarkerSync`, `hashFileSync`, `statSync`, `writeFileSync`, `copyFileSync`, `unlinkSync`, `createReadStream`) and register it beside `local` and `s3` in `getStorageDriver` inside `localFolder.js`. Keep path checks in `fileStore`. Do not write a second copy of the upload, download, or move logic.

The local methods stay synchronous. The S3 driver is asynchronous: callers of `openStored`, `removeStored`, `writeNewFile`, and `sendStoredDownload` await a promise when that driver is selected, and the local driver still returns its result immediately. A failure is still "storage unavailable", so a down service returns HTTP 503 instead of crashing the process.
