import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node23',
  outDir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  external: ['@node-rs/argon2', '@subspace/reed-solomon-erasure.wasm'],
});
