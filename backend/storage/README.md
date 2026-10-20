# Storage drivers

Uploads, downloads, deletes, the orphan sweep, shared files, proofs, and inbound-email attachments all go through `backend/fileStore.js`. That module asks a storage driver to touch bytes. The driver in use is `local`.

`FILE_STORAGE_DRIVER` selects the driver. When it is unset, the local folder driver is used. Any other name fails with a clear error. The server keeps running.

## Local folder

`localFolder.js` stores each file in one folder on a filesystem the operating system can see. That folder can be a local disk, a mapped drive such as `Z:\launchpad`, or a network share such as `\\server\share\launchpad`. The folder is chosen in System Settings and stored in `system_settings.file_storage_dir`. When that key is empty, `UPLOAD_DIR` is used, then `data/uploads`.

The driver can create the folder, report free space, and write, read, and delete a file. `fileStore` still rejects a stored name that is not a random id plus an allowed extension, and it still refuses a path that escapes the folder.

## OneDrive and SharePoint

A cloud driver is not included. To add one later, implement the same methods as the local driver (`status`, `ensureSync`, `probeSync`, `statSync`, `writeFileSync`, `copyFileSync`, `unlinkSync`, `createReadStream`) and register it in `DRIVERS` inside `localFolder.js` (or a sibling module that this file requires). Keep path checks in `fileStore`. Do not write a second copy of the upload, download, or move logic.

The local methods are synchronous because multipart upload and the mailbox import already run that way. A cloud driver can do its network I/O inside those methods. Callers should keep treating a failure as "storage unavailable" so a down service returns HTTP 503 instead of crashing the process.
