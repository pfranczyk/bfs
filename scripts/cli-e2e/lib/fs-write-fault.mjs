// Preload that installs the write-fault hooks. Passed to the CLI through
// NODE_OPTIONS by scenarios that need one refused write inside the pack; with
// BFS_FAULT_KIND unset the hooks resolve to a plain re-export, so loading this
// unconditionally would still leave the CLI behaving normally.
import { register } from 'node:module';

register('./fs-write-fault-hooks.mjs', import.meta.url);
