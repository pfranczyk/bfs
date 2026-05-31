import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root (scripts/smoke-config.ts → scripts/ → ..)
export const PROJECT_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
);

const args = process.argv.slice(2);
const binArg = args.find((a) => a.startsWith('--bin='));
// Always absolute — bin is invoked from a different cwd (vault dir)
export const bin = path.resolve(
  PROJECT_ROOT,
  binArg ? binArg.slice(6) : 'src/index.ts',
);
