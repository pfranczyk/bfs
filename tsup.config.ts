import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  target: 'node23' as const,
  outDir: 'dist',
  external: ['@node-rs/argon2', '@subspace/reed-solomon-erasure.wasm'],
};

// Two builds: the CLI binary (needs shebang) and the adapter library
// (needs .d.ts, no shebang). The CLI config cleans dist first; the library
// config runs second and must NOT clean.
export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
  },
  {
    ...shared,
    entry: ['src/lib.ts'],
    dts: true,
    clean: false,
  },
]);
