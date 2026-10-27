// Preload that installs the crash-mid-write hooks. Passed to the CLI through
// NODE_OPTIONS by scenarios that need the process to die inside one file's
// write; with BFS_CRASH_FILE unset the hooks resolve to a plain re-export, so
// loading this unconditionally would still leave the CLI behaving normally.
import { register } from 'node:module';

register('./fs-crash-hooks.mjs', import.meta.url);
