/**
 * Starts a Docker FTP server, runs smoke tests with BFS_FTP_TEST=1,
 * then stops and removes the container.
 *
 * Usage: npm run smoke:ftp
 */

import { spawnSync } from 'node:child_process';
import net from 'node:net';

const CONTAINER_NAME = 'bfs-ftp-test';
const FTP_PORT = 21;
const PASV_PORTS = '21000-21010';
const FTP_USER = 'bfsuser';
const FTP_PASS = 'bfspass';
const IMAGE = 'delfer/alpine-ftp-server';
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

function dockerRun(): void {
  const result = spawnSync('docker', ['run', '-d', '--name', CONTAINER_NAME, '-p', `${FTP_PORT}:21`, '-p', `${PASV_PORTS}:${PASV_PORTS}`, '-e', `USERS=${FTP_USER}|${FTP_PASS}`, IMAGE]);
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr?.toString() ?? 'unknown error'}`);
  }
  console.log(`[FTP-TEST] Container ${CONTAINER_NAME} started.`);
}

function dockerStop(): void {
  spawnSync('docker', ['stop', CONTAINER_NAME], { stdio: 'ignore' });
}

function dockerRm(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
}

function waitForFtp(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function tryConnect(): void {
      if (Date.now() > deadline) {
        reject(new Error(`FTP server did not respond on port ${port} within ${timeoutMs}ms`));
        return;
      }

      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.setTimeout(2000);

      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        setTimeout(tryConnect, POLL_INTERVAL_MS);
      });

      socket.on('timeout', () => {
        socket.destroy();
        setTimeout(tryConnect, POLL_INTERVAL_MS);
      });
    }

    tryConnect();
  });
}

async function main(): Promise<void> {
  // Step 1: Cleanup old container if it exists
  console.log('[FTP-TEST] Cleaning up old container (if any)...');
  dockerStop();
  dockerRm();

  // Step 2: Start container
  console.log('[FTP-TEST] Starting FTP server...');
  dockerRun();

  let smokeStatus = 1;
  try {
    // Step 3: Wait for FTP server to be ready
    console.log(`[FTP-TEST] Waiting for FTP server on port ${FTP_PORT} (timeout ${STARTUP_TIMEOUT_MS}ms)...`);
    await waitForFtp(FTP_PORT, STARTUP_TIMEOUT_MS);
    console.log('[FTP-TEST] FTP server is ready.');

    // Step 4: Run smoke tests
    console.log('[FTP-TEST] Running smoke tests with BFS_FTP_TEST=1...');
    const result = spawnSync('npm', ['run', 'smoke'], { env: { ...process.env, BFS_FTP_TEST: '1' }, stdio: 'inherit', shell: true });
    smokeStatus = result.status ?? 1;
  } finally {
    // Step 5: Always stop and remove container
    console.log('[FTP-TEST] Stopping and removing container...');
    dockerStop();
    dockerRm();
  }

  // Step 6: Exit with smoke test status
  process.exit(smokeStatus);
}

main().catch((err) => {
  console.error('[FTP-TEST] Fatal:', err instanceof Error ? err.message : String(err));
  dockerStop();
  dockerRm();
  process.exit(1);
});
