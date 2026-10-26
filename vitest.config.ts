import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    // @node-rs/argon2 uses WASM (via @emnapi/core) which cannot initialize
    // its worker-thread pool inside Vitest's worker-thread sandbox.
    // Using 'forks' runs each test file in a child process with a full Node.js
    // environment, letting the WASM module load correctly.
    pool: 'forks',
    // A ceiling for a hang, not a speed budget. Encrypted tests spend most of
    // their time in Argon2, which slows down several-fold when the machine is
    // busy - a CI runner sharing its host, a parallel run - and the defaults (5 s
    // per test, 10 s per hook) then fail a test that did nothing wrong. A test
    // still ends the moment its work does; only a real hang waits this long.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude],
  },
});
