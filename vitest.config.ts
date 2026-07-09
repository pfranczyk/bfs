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
    // Isolated agent worktrees live under .claude/worktrees and carry their own
    // copy of the tree (including test files). Without this, a leftover worktree
    // makes vitest run — and possibly fail on — a second, stale copy of the suite.
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
});
