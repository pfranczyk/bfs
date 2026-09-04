// Module hooks that put one refused write in the path of the real CLI.
//
// A backup volume that fills up mid-pack cannot be staged from the outside on
// every platform the harness runs on, and the shape that actually damages a
// backup is not a volume that stays full - that one also refuses the final
// write, so the pack aborts and the operator is told the truth. The damaging
// shape is a single write that fails and lets the rest through, which leaves
// the pack to finish and seal an archive short of a member. Refusing one write
// inside the process reproduces exactly that, on every platform, without
// needing a real disk to run out.
//
// The interception has to happen at module resolution: blob-pack.ts imports the
// namespace (`import * as fs`), and an ES module namespace is read-only, so
// replacing a property on it is not possible.
//
// Configured through the environment, so the scenario stays declarative:
//   BFS_FAULT_KIND  lfh | data | dd  - which of the three writes a file costs
//   BFS_FAULT_AT    1-based occurrence of that kind to refuse
//   BFS_FAULT_CODE  errno to refuse with (default ENOSPC)

const SHIM = 'bfs-fault:fs-promises';

/** Redirects fs/promises to the shim below, leaving every other specifier alone. */
export async function resolve(specifier, context, next) {
  if (specifier === 'node:fs/promises' || specifier === 'fs/promises') {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}

/** Builds the shim: the real module re-exported, with `open` wrapped. */
export async function load(url, context, next) {
  if (url !== SHIM) return next(url, context);
  const real = process.getBuiltinModule('fs/promises');
  // Re-exported by name so the shim is a drop-in for both `import fs from` and
  // `import * as fs from`. `process.getBuiltinModule` reaches the real module
  // without going through resolve again, so the shim cannot import itself.
  const passthrough = Object.keys(real).filter((name) => name !== 'open' && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
  const source = `
const real = process.getBuiltinModule('fs/promises');
const KIND = process.env.BFS_FAULT_KIND ?? '';
const AT = Number(process.env.BFS_FAULT_AT ?? '0');
const CODE = process.env.BFS_FAULT_CODE ?? 'ENOSPC';
const SIG_LFH = 0x04034b50;
const SIG_DD = 0x08074b50;
let writes = 0;
let seen = 0;

export async function open(...args) {
  const handle = await real.open(...args);
  // Only the packed-blob file in the cache directory is a candidate; every
  // other handle this process opens must behave normally.
  if (!KIND || typeof args[0] !== 'string' || !/push\\.blob\\.pending$/.test(args[0])) return handle;
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === 'write') {
        return async (...w) => {
          writes += 1;
          const buf = w[0];
          // The first write is the header/table placeholder; classifying it
          // would put a header-sized write ahead of the first local header.
          if (writes > 1 && Buffer.isBuffer(buf) && buf.length >= 4) {
            const sig = buf.readUInt32LE(0);
            const kind = sig === SIG_LFH ? 'lfh' : sig === SIG_DD ? 'dd' : 'data';
            if (kind === KIND) {
              seen += 1;
              if (seen === AT) {
                const err = new Error(CODE + ': no space left on device, write');
                err.code = CODE;
                err.syscall = 'write';
                throw err;
              }
            }
          }
          return target.write(...w);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
${passthrough.map((name) => `export const ${name} = real.${name};`).join('\n')}
export default { ...real, open };
`;
  return { format: 'module', shortCircuit: true, source };
}
