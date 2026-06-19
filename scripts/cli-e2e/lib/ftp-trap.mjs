// Credential-phishing trap server for cli-e2e — a minimal, hostile "FTP" server
// that exists ONLY to capture whatever password an unsuspecting client sends it.
//
// It speaks just enough of the FTP control protocol (node:net, no deps) to make
// basic-ftp send USER then PASS:
//   on connect  → 220 greeting
//   on USER x   → 331 (need password)
//   on PASS y   → append the raw USER/PASS lines to the log file, then 530 + close
//
// This models an attacker host named in a forged, unencrypted shard location_map.
// If `bfs recovery` connects (authenticate) BEFORE proving the host to the
// operator, the operator's typed secret lands in this log — that leak is exactly
// what the credential-leak e2e scenario asserts must NOT happen.
//
// Invocation:  node ftp-trap.mjs <logFile> [port]
//   <logFile>  path the captured USER/PASS lines are appended to
//   [port]     listen port on 127.0.0.1 (0 = ephemeral; default 0)
// Prints "LISTENING <port>" on stdout once bound so the scenario can proceed.
// Exits cleanly on SIGTERM/SIGINT.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import process from 'node:process';

const [logFile, portArg] = process.argv.slice(2);
if (!logFile) {
  process.stderr.write('ftp-trap: usage: node ftp-trap.mjs <logFile> [port]\n');
  process.exit(2);
}
const port = Number(portArg ?? '0');

const server = createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 bfs-trap ready\r\n');

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      handleLine(socket, line);
      nl = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => {
    // Client may reset the connection on the 530 — nothing to do.
  });
});

/**
 * Drives the minimal FTP login handshake and records any captured credential.
 * @param {import('node:net').Socket} socket - control connection
 * @param {string} line - one CRLF-terminated control command
 * @returns {void}
 */
function handleLine(socket, line) {
  const upper = line.toUpperCase();
  if (upper.startsWith('USER')) {
    appendFileSync(logFile, `${line}\n`);
    socket.write('331 need password\r\n');
    return;
  }
  if (upper.startsWith('PASS')) {
    // The captured secret — this is the whole point of the trap.
    appendFileSync(logFile, `${line}\n`);
    socket.write('530 login incorrect\r\n');
    socket.end();
    return;
  }
  // Anything else before login: keep the dialogue alive until PASS arrives.
  socket.write('530 please login with USER and PASS\r\n');
}

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  process.stdout.write(`LISTENING ${boundPort}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // Force-exit if a lingering socket keeps the server open.
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
