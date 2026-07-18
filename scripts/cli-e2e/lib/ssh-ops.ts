// SSH/SFTP operations helper for the CLI e2e harness. Reuses the project's
// existing ssh2 dependency (no new deps) to prepare and tear down the harness's
// namespaced test directories on a dedicated test SSH account.
//
// Driven entirely by environment variables so credentials never appear in the
// process argument list:
//   SO_HOST SO_PORT SO_USER SO_PASS SO_BASE   connection + base path
//   SO_MODE   'mkdir' → ensureDir each path in SO_PATHS ('|'-separated). BFS
//                       init lists a provider's base path and fails if absent,
//                       so the harness must create it first (like a local
//                       provider's `mkdir -p`).
//             'file'  → write a 1-byte regular file at SO_FILE (parent dir
//                       ensured first). Used to plant a "path segment is a file"
//                       obstacle so a directory op nested under it fails on any
//                       compliant server, regardless of write permissions.
//             'rename'→ move SO_FROM → SO_TO (the parent of SO_TO is ensured
//                       first). Simulates a storage relocation an operator then
//                       points a provider at with `bfs provider edit`.
//             'rm'    → delete the single remote file SO_FILE (a shard), to
//                       simulate a lost shard / unreachable server for RS
//                       reconstruction tests. Missing file is a no-op.
//             'put'   → upload the local file SO_LOCAL to the remote path SO_FILE
//                       (parent ensured first). Used to pre-place the SAME shard
//                       bytes on a new-type provider before a no-rebuild repair
//                       repoints to it — the cross-type "canonical layout"
//                       migration (local → ftp → ssh).
//             'run'   → remove SO_BASE/bfs-e2e-<SO_RUN> only.
//             'all'   → remove every SO_BASE/bfs-e2e-* directory.
//             'sha'   → download SO_FILE, print its SHA-256 (hex) to stdout.
//                       Exit 3 when the file is absent so callers can
//                       distinguish "not there" from a real transport error.
//                       Read-only; used by e2e to prove a repair did NOT
//                       re-upload a shard (hash unchanged) and that a header
//                       sidecar landed remotely (hash obtainable).
//
// ssh2's SFTP mkdir/rmdir are single-level (unlike basic-ftp's recursive
// ensureDir/removeDir), so this helper implements its own recursive versions.
//
// Destructive modes only ever touch directories named `bfs-e2e-*`.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type FileEntry, type SFTPWrapper } from 'ssh2';

const CONNECT_TIMEOUT_MS = 15_000;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** Directory test that works with both ssh2 Stats (isDirectory) and raw attrs.mode. */
function entryIsDirectory(entry: FileEntry): boolean {
  const attrs = entry.attrs as { isDirectory?: () => boolean; mode?: number };
  if (typeof attrs.isDirectory === 'function') return attrs.isDirectory();
  return typeof attrs.mode === 'number' && (attrs.mode & S_IFMT) === S_IFDIR;
}

/** Opens an SSH connection and resolves once it is ready. */
function connect(host: string, port: number, user: string, password: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn)).on('error', reject);
    conn.connect({
      host,
      port,
      username: user,
      password,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // The harness owns the test server, so its host key is trusted
      // unconditionally — parallel to ftp-ops' rejectUnauthorized:false under
      // FTPS. This is harness plumbing, not a security decision under test:
      // BFS's own TOFU/known_hosts path is exercised by the `bfs` invocations.
      hostVerifier: () => true,
    });
  });
}

/** Opens the SFTP session on a ready connection. */
function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err || !sftp ? reject(err ?? new Error('sftp session unavailable')) : resolve(sftp)));
  });
}

function readdirAsync(sftp: SFTPWrapper, dir: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

function mkdirAsync(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

function rmdirAsync(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

function unlinkAsync(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

function renameAsync(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}

function writeFileAsync(sftp: SFTPWrapper, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, (err) => (err ? reject(err) : resolve()));
  });
}

/** True when the remote path exists as a directory. */
function dirExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stats.isDirectory());
    });
  });
}

/**
 * Recursively creates a remote directory (POSIX, absolute). Each segment is
 * created in turn; an "already exists" failure is tolerated only when the
 * segment is confirmed present, so a genuine permission error still surfaces.
 */
async function ensureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      await mkdirAsync(sftp, current);
    } catch (err) {
      if (!(await dirExists(sftp, current))) throw err;
    }
  }
}

/**
 * Recursively removes a remote directory tree. A missing directory is a no-op
 * (nothing to clean). Files are unlinked, subdirectories recursed into, then the
 * directory itself is removed.
 */
async function removeDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  let entries: FileEntry[];
  try {
    entries = await readdirAsync(sftp, dir);
  } catch {
    return; // does not exist → nothing to remove
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.filename}`;
    if (entryIsDirectory(entry)) {
      await removeDir(sftp, full);
    } else {
      await unlinkAsync(sftp, full);
    }
  }
  await rmdirAsync(sftp, dir);
}

/** Downloads a remote file via SFTP and returns its SHA-256 (hex). */
function downloadSha(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = sftp.createReadStream(remotePath);
    rs.on('data', (chunk: Buffer | string) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

function parentOf(remotePath: string): string {
  return remotePath.replace(/\/[^/]*$/, '') || '/';
}

async function main(): Promise<void> {
  const host = env('SO_HOST');
  if (!host) {
    console.error('ssh-ops: SO_HOST not set');
    process.exit(2);
  }
  const base = env('SO_BASE', '/');
  const mode = env('SO_MODE', 'run');
  const baseTrim = base.replace(/\/+$/, '');

  const conn = await connect(host, Number(env('SO_PORT', '22')), env('SO_USER'), env('SO_PASS'));
  try {
    const sftp = await openSftp(conn);

    if (mode === 'mkdir') {
      for (const p of env('SO_PATHS').split('|')) {
        if (p) await ensureDir(sftp, p);
      }
    } else if (mode === 'file') {
      const filePath = env('SO_FILE');
      if (filePath) {
        await ensureDir(sftp, parentOf(filePath));
        await writeFileAsync(sftp, filePath, Buffer.from('x'));
      }
    } else if (mode === 'rename') {
      const from = env('SO_FROM');
      const to = env('SO_TO');
      if (from && to) {
        await ensureDir(sftp, parentOf(to));
        await renameAsync(sftp, from, to);
      }
    } else if (mode === 'all') {
      let entries: FileEntry[];
      try {
        entries = await readdirAsync(sftp, base);
      } catch {
        return; // base path does not exist → nothing to clean
      }
      for (const item of entries) {
        if (entryIsDirectory(item) && item.filename.startsWith('bfs-e2e-')) {
          await removeDir(sftp, `${baseTrim}/${item.filename}`);
          console.log(`removed ${host}:${baseTrim}/${item.filename}`);
        }
      }
    } else if (mode === 'rm') {
      const file = env('SO_FILE');
      if (file) {
        try {
          await unlinkAsync(sftp, file);
        } catch {
          // already gone — nothing to remove
        }
      }
    } else if (mode === 'put') {
      const local = env('SO_LOCAL');
      const remote = env('SO_FILE');
      if (local && remote) {
        await ensureDir(sftp, parentOf(remote));
        await writeFileAsync(sftp, remote, await readFile(local));
      }
    } else if (mode === 'run') {
      const runId = env('SO_RUN');
      if (runId) {
        await removeDir(sftp, `${baseTrim}/bfs-e2e-${runId}`);
      }
    } else if (mode === 'sha') {
      const file = env('SO_FILE');
      if (!file) {
        console.error('ssh-ops: SO_FILE not set for sha');
        process.exit(2);
      }
      let digest: string;
      try {
        digest = await downloadSha(sftp, file);
      } catch {
        // missing file or any transport failure → signal "absent" distinctly.
        process.exit(3);
      }
      process.stdout.write(`${digest}\n`);
    }
  } finally {
    conn.end();
  }
}

main().catch((err: unknown) => {
  console.error(`ssh-ops: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
