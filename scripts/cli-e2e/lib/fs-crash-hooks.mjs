// Module hooks that kill the real CLI halfway through writing one file.
//
// A process that dies while a small JSON file is being rewritten (a crash, a
// kill, a closed terminal) cannot be staged from the outside: the write takes
// microseconds and no signal sent by the harness lands inside it. What the
// death leaves behind is the part that matters - whatever bytes the process
// handed over before it stopped - so the shim writes half of the payload and
// ends the process on the spot, with no chance to clean up or report.
//
// This models the death of the process, not a power cut: the kernel outlives
// the process and keeps what it was given, so what a lost page cache does to
// the file is outside what this hook can show.
//
// The target is a file directly under `.bfs/`, written with
// `fs/promises.writeFile` and a string path, matched by its final name and
// also by a temporary sibling named after it (`<name>.<pid>.tmp`).
//
// The interception has to happen at module resolution: an ES module namespace
// is read-only, so replacing a property on it from the outside is not possible.
//
// Configured through the environment, so the scenario stays declarative:
//   BFS_CRASH_FILE  base name of the file whose write is cut short (e.g. state.json)
//   BFS_CRASH_EXIT  exit code the process dies with (default 86)

const SHIM = 'bfs-crash:fs-promises';

/** Redirects fs/promises to the shim below, leaving every other specifier alone. */
export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs/promises' || specifier === 'fs/promises') {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}

/** Builds the shim: the real module re-exported, with `writeFile` wrapped. */
export async function load(url, context, next) {
  if (url !== SHIM) return next(url, context);
  const real = process.getBuiltinModule('fs/promises');
  // Re-exported by name so the shim is a drop-in for both `import fs from` and
  // `import * as fs from`. `process.getBuiltinModule` reaches the real module
  // without going through resolve again, so the shim cannot import itself.
  const passthrough = Object.keys(real).filter((name) => name !== 'writeFile' && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
  const source = `
const real = process.getBuiltinModule('fs/promises');
const path = process.getBuiltinModule('path');
const NAME = process.env.BFS_CRASH_FILE ?? '';
const EXIT = Number(process.env.BFS_CRASH_EXIT ?? '86');

function isTarget(file) {
  if (!NAME || typeof file !== 'string') return false;
  // Only the backup's own metadata directory: a user file restored under the
  // same name must be written normally.
  if (path.basename(path.dirname(file)) !== '.bfs') return false;
  const base = path.basename(file);
  if (base === NAME) return true;
  if (!base.startsWith(NAME + '.') || !base.endsWith('.tmp')) return false;
  const middle = base.slice(NAME.length + 1, -'.tmp'.length);
  return middle.length > 0 && [...middle].every((c) => c >= '0' && c <= '9');
}

export async function writeFile(file, data, options) {
  if (!isTarget(file)) return real.writeFile(file, data, options);
  const text = String(data);
  await real.writeFile(file, text.slice(0, Math.floor(text.length / 2)), options);
  process.exit(EXIT);
}
${passthrough.map((name) => `export const ${name} = real.${name};`).join('\n')}
export default { ...real, writeFile };
`;
  return { format: 'module', shortCircuit: true, source };
}
