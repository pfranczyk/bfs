// FTP operations helper for the CLI e2e harness. Reuses the project's existing
// basic-ftp dependency (no new deps) to prepare and tear down the harness's
// namespaced test directories on a dedicated test FTP account.
//
// Driven entirely by environment variables so credentials never appear in the
// process argument list:
//   FC_HOST FC_PORT FC_USER FC_PASS FC_SECURE FC_BASE   connection + base path
//   FC_MODE   'mkdir' → ensureDir each path in FC_PATHS ('|'-separated). BFS
//                       init lists a provider's base path and fails if absent,
//                       so the harness must create it first (like a local
//                       provider's `mkdir -p`).
//             'file'  → upload a 1-byte regular file at FC_FILE (parent dir
//                       ensured first). Used to plant a "path segment is a file"
//                       obstacle so a directory op nested under it fails 550 on
//                       any compliant server, regardless of write permissions.
//             'rename'→ move FC_FROM → FC_TO (the parent of FC_TO is ensured
//                       first). Simulates a storage relocation an operator then
//                       points a provider at with `bfs provider edit`.
//             'put'   → upload the local file FC_LOCAL to the remote path FC_FILE
//                       (parent ensured first). Pre-places identical shard bytes
//                       on a new-type provider before a no-rebuild repair
//                       repoints to it (cross-type canonical-layout migration).
//             'run'   → remove FC_BASE/bfs-e2e-<FC_RUN> only.
//             'all'   → remove every FC_BASE/bfs-e2e-* directory.
//             'sha'   → download FC_FILE, print its SHA-256 (hex) to stdout.
//                       Exit 3 when the file is absent (550) so callers can
//                       distinguish "not there" from a real transport error.
//                       Read-only; used by e2e to prove a repair did NOT
//                       re-upload a shard (hash unchanged) and that a header
//                       sidecar landed remotely (hash obtainable).
//
// Destructive modes only ever touch directories named `bfs-e2e-*`.

import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { Client, type FileInfo } from 'basic-ftp';

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

async function main(): Promise<void> {
  const host = env('FC_HOST');
  if (!host) {
    console.error('ftp-ops: FC_HOST not set');
    process.exit(2);
  }
  const secure = env('FC_SECURE') === 'true';
  const base = env('FC_BASE', '/');
  const mode = env('FC_MODE', 'run');
  const baseTrim = base.replace(/\/+$/, '');

  const client = new Client(15_000);
  try {
    await client.access({
      host,
      port: Number(env('FC_PORT', '21')),
      user: env('FC_USER'),
      password: env('FC_PASS'),
      secure,
      // Test servers commonly use self-signed certs; be lenient under FTPS.
      ...(secure ? { secureOptions: { rejectUnauthorized: false } } : {}),
    });

    if (mode === 'mkdir') {
      for (const p of env('FC_PATHS').split('|')) {
        if (p) {
          await client.ensureDir(p);
        }
      }
    } else if (mode === 'file') {
      const filePath = env('FC_FILE');
      if (filePath) {
        const dir = filePath.replace(/\/[^/]*$/, '') || '/';
        await client.ensureDir(dir);
        // ensureDir leaves CWD in `dir`; uploadFrom with the absolute path
        // still STORs to the right place (same pattern as probeConnection).
        await client.uploadFrom(Readable.from(Buffer.from('x')), filePath);
      }
    } else if (mode === 'rename') {
      const from = env('FC_FROM');
      const to = env('FC_TO');
      if (from && to) {
        const parent = to.replace(/\/[^/]*$/, '') || '/';
        await client.ensureDir(parent);
        // ensureDir leaves CWD in `parent`; rename uses absolute paths.
        await client.rename(from, to);
      }
    } else if (mode === 'put') {
      const local = env('FC_LOCAL');
      const remote = env('FC_FILE');
      if (local && remote) {
        const dir = remote.replace(/\/[^/]*$/, '') || '/';
        await client.ensureDir(dir);
        // uploadFrom(localPath) streams via Node's 64 KB createReadStream — the
        // chunked path (see .claude/rules/streaming.md).
        await client.uploadFrom(local, remote);
      }
    } else if (mode === 'all') {
      let entries: FileInfo[];
      try {
        entries = await client.list(base);
      } catch {
        return; // base path does not exist → nothing to clean
      }
      for (const item of entries) {
        if (item.isDirectory && item.name.startsWith('bfs-e2e-')) {
          await client.removeDir(`${baseTrim}/${item.name}`);
          console.log(`removed ${host}:${baseTrim}/${item.name}`);
        }
      }
    } else if (mode === 'run') {
      const runId = env('FC_RUN');
      if (runId) {
        try {
          await client.removeDir(`${baseTrim}/bfs-e2e-${runId}`);
        } catch {
          // nothing to remove for this run on this endpoint
        }
      }
    } else if (mode === 'sha') {
      const file = env('FC_FILE');
      if (!file) {
        console.error('ftp-ops: FC_FILE not set for sha');
        process.exit(2);
      }
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer | Uint8Array, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        },
      });
      try {
        await client.downloadTo(sink, file);
      } catch {
        // 550 (missing) or any transport failure → signal "absent" distinctly.
        process.exit(3);
      }
      process.stdout.write(`${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}\n`);
    }
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`ftp-ops: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
