// Shard-forging helper for cli-e2e — rewrites a `--no-enc` shard in place and
// re-seals it with a freshly computed trailing SHA-256, so the forgery is
// byte-valid. With encryption off a shard's header and location_map are plain,
// guarded only by an UNKEYED trailing checksum, which buildShardV2 recomputes —
// so the checksum guards nothing against an attacker who can rewrite the shard.
// Reuses the project's own shard-io codec (no new deps).
//
// Two tamper modes:
//
// 1) location_map redirect (credential-phishing vector):
//    tsx tamper-shard.ts <shardPath> <siblingIndex> <trapHost> <trapPort>
//      <shardPath>     path to the bootstrap shard file to forge in place
//      <siblingIndex>  shard_index of the location_map entry to redirect
//      <trapHost>      attacker host to redirect the sibling to (e.g. 127.0.0.1)
//      <trapPort>      attacker port
//
// 2) header metadata forge (heal cross-validation vector):
//    tsx tamper-shard.ts <shardPath> --meta <field> <value>
//      <field>  one of: blob_hash | vault_name
//      <value>  replacement value (e.g. ffff…ff for blob_hash, a rogue name)
//    Heal (`bfs provider remove --strategy rebuild`) adopts shard metadata from
//    the first available sibling; forging ONE sibling's blob_hash/vault_name
//    plants divergent metadata heal must detect rather than silently trust.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { buildShardHeaderFromBytes, buildShardV2, computeShardHeaderSize } from '../../../src/core/shard-io.js';
import type { ShardLocation } from '../../../src/types/index.js';

const SHA256_BYTES = 32;

/** Re-seals a shard whose header was mutated, recomputing the trailing checksum. */
function reseal(shardPath: string, mutate: (header: ReturnType<typeof buildShardHeaderFromBytes>) => void): void {
  const shard = readFileSync(shardPath);
  const headerSize = computeShardHeaderSize(shard);
  const payload = shard.subarray(headerSize, shard.length - SHA256_BYTES);
  // No encryption key: the header (incl. location map) is plain, fully writable.
  const header = buildShardHeaderFromBytes(shard.subarray(0, headerSize));
  mutate(header);
  writeFileSync(shardPath, buildShardV2(header, payload));
}

function tamperMeta(shardPath: string, field: string, value: string): void {
  if (field !== 'blob_hash' && field !== 'vault_name') {
    process.stderr.write(`tamper-shard: --meta field must be blob_hash|vault_name, got "${field}"\n`);
    process.exit(2);
  }
  reseal(shardPath, (header) => {
    if (field === 'blob_hash') header.blob_hash = value;
    else header.vault_name = value;
  });
  process.stdout.write(`TAMPERED meta ${field}=${value}\n`);
}

function tamperLocationMap(shardPath: string, siblingIndex: number, trapHost: string, trapPort: number): void {
  let found = false;
  reseal(shardPath, (header) => {
    const target = header.location_map.find((entry) => entry.shard_index === siblingIndex);
    if (!target) return;
    found = true;
    const forged: ShardLocation = {
      ...target,
      provider_type: 'ftp',
      adapterPackage: null,
      connection_config: { host: trapHost, port: trapPort, user: 'victim', secure: false },
      required_inputs: ['password'],
      remote_path: '/bfs-trap/shard',
    };
    header.location_map = header.location_map.map((entry) => (entry.shard_index === siblingIndex ? forged : entry));
  });
  if (!found) {
    process.stderr.write(`tamper-shard: no location_map entry with shard_index=${siblingIndex}\n`);
    process.exit(1);
  }
  process.stdout.write(`TAMPERED shard_index=${siblingIndex} -> ftp ${trapHost}:${trapPort}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const [shardPath, second] = args;
  if (!shardPath) {
    process.stderr.write('tamper-shard: usage: tsx tamper-shard.ts <shardPath> (<siblingIndex> <trapHost> <trapPort> | --meta <field> <value>)\n');
    process.exit(2);
  }

  if (second === '--meta') {
    const field = args[2];
    const value = args[3];
    if (field === undefined || value === undefined) {
      process.stderr.write('tamper-shard: usage: tsx tamper-shard.ts <shardPath> --meta <field> <value>\n');
      process.exit(2);
    }
    tamperMeta(shardPath, field, value);
    return;
  }

  const siblingArg = args[1];
  const trapHost = args[2];
  const trapPortArg = args[3];
  if (siblingArg === undefined || !trapHost || trapPortArg === undefined) {
    process.stderr.write('tamper-shard: usage: tsx tamper-shard.ts <shardPath> <siblingIndex> <trapHost> <trapPort>\n');
    process.exit(2);
  }
  tamperLocationMap(shardPath, Number(siblingArg), trapHost, Number(trapPortArg));
}

main();
