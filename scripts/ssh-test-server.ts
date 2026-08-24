/**
 * Starts a Docker OpenSSH server, runs smoke tests with BFS_SSH_TEST=1,
 * then stops and removes the container.
 *
 * An ephemeral ed25519 keypair is generated per run: the public key is injected
 * into the container (authorized_keys via PUBLIC_KEY) and the private key is
 * written to a temp file whose path is handed to the smoke suite for the
 * key-auth path. Both are discarded when the run ends.
 *
 * Usage: npm run smoke:ssh
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

// ssh2 is CJS; its cjs-module-lexer surface exposes `Client` as a named ESM
// binding but NOT `utils`, so a `{ utils }` named import fails at runtime. The
// default import binds the whole module.exports, where `utils` is present.
const { Client } = ssh2;
const sshUtils = ssh2.utils;

const CONTAINER_NAME = 'bfs-ssh-test';
const SSH_PORT = 2222;
const SSH_USER = 'bfsuser';
const SSH_PASS = 'bfspass';
// linuxserver/openssh-server creates the user with home /config (the persisted,
// user-owned volume) - the SFTP session lands there and it is writable.
const SSH_BASE_PATH = '/config';
const IMAGE = 'linuxserver/openssh-server';
const STARTUP_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_000;
const HANDSHAKE_TIMEOUT_MS = 4_000;

function dockerRun(publicKey: string): void {
  const result = spawnSync('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `${SSH_PORT}:2222`,
    '-e',
    'PUID=1000',
    '-e',
    'PGID=1000',
    '-e',
    'PASSWORD_ACCESS=true',
    '-e',
    `USER_NAME=${SSH_USER}`,
    '-e',
    `USER_PASSWORD=${SSH_PASS}`,
    '-e',
    `PUBLIC_KEY=${publicKey}`,
    '-e',
    'SUDO_ACCESS=false',
    IMAGE,
  ]);
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr?.toString() ?? 'unknown error'}`);
  }
  console.log(`[SSH-TEST] Container ${CONTAINER_NAME} started.`);
}

function dockerStop(): void {
  spawnSync('docker', ['stop', CONTAINER_NAME], { stdio: 'ignore' });
}

function dockerRm(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
}

/**
 * Resolves once a full password SSH handshake to the container succeeds. A bare
 * TCP connect is not enough - sshd binds the port before s6 finishes creating
 * the user, so readiness must be an actual authenticated `ready`.
 */
function waitForSsh(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function tryConnect(): void {
      const conn = new Client();
      let settled = false;
      conn.on('ready', () => {
        if (settled) return;
        settled = true;
        conn.end();
        resolve();
      });
      conn.on('error', () => {
        conn.end();
        if (settled) return;
        if (Date.now() > deadline) {
          settled = true;
          reject(new Error(`SSH server did not accept auth on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(tryConnect, POLL_INTERVAL_MS);
      });
      conn.connect({ host: '127.0.0.1', port, username: SSH_USER, password: SSH_PASS, readyTimeout: HANDSHAKE_TIMEOUT_MS, hostVerifier: () => true });
    }
    tryConnect();
  });
}

async function main(): Promise<void> {
  // Ephemeral keypair for the key-auth smoke path (public -> container, private -> temp file).
  const { private: privateKey, public: publicKey } = sshUtils.generateKeyPairSync('ed25519');
  const keyPath = path.join(os.tmpdir(), `bfs-ssh-test-key-${Date.now()}`);
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

  // Step 1: Cleanup old container if it exists
  console.log('[SSH-TEST] Cleaning up old container (if any)...');
  dockerStop();
  dockerRm();

  // Step 2: Start container
  console.log('[SSH-TEST] Starting SSH server...');
  dockerRun(publicKey);

  let smokeStatus = 1;
  try {
    // Step 3: Wait for the SSH server to accept an authenticated connection
    console.log(`[SSH-TEST] Waiting for SSH server on port ${SSH_PORT} (timeout ${STARTUP_TIMEOUT_MS}ms)...`);
    await waitForSsh(SSH_PORT, STARTUP_TIMEOUT_MS);
    console.log('[SSH-TEST] SSH server is ready.');

    // Step 4: Run smoke tests
    console.log('[SSH-TEST] Running smoke tests with BFS_SSH_TEST=1...');
    const result = spawnSync('npm', ['run', 'smoke'], {
      env: { ...process.env, BFS_SSH_TEST: '1', BFS_SSH_HOST: '127.0.0.1', BFS_SSH_PORT: String(SSH_PORT), BFS_SSH_USER: SSH_USER, BFS_SSH_PASSWORD: SSH_PASS, BFS_SSH_PATH: SSH_BASE_PATH, BFS_SSH_PRIVATE_KEY: keyPath },
      stdio: 'inherit',
      shell: true,
    });
    smokeStatus = result.status ?? 1;
  } finally {
    // Step 5: Always stop and remove container + discard the private key
    console.log('[SSH-TEST] Stopping and removing container...');
    dockerStop();
    dockerRm();
    fs.rmSync(keyPath, { force: true });
  }

  // Step 6: Exit with smoke test status
  process.exit(smokeStatus);
}

main().catch((err) => {
  console.error('[SSH-TEST] Fatal:', err instanceof Error ? err.message : String(err));
  dockerStop();
  dockerRm();
  process.exit(1);
});
