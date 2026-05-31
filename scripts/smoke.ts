/**
 * Smoke test CLI: verifies that bfs works as a running process (not just as a module).
 *
 * Usage:
 *   npx tsx scripts/smoke.ts                    # testuje src/index.ts
 *   npx tsx scripts/smoke.ts --bin=dist/index.js # testuje skompilowany dist
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bin } from './smoke-config.js';
import { printSuite } from './smoke-runner.js';
import type { SmokeContext } from './smoke-types.js';
import { createTestFiles, setupVault } from './smoke-vault.js';
import { suiteA } from './suites/suite-a.js';
import { suiteB } from './suites/suite-b.js';
import { suiteC } from './suites/suite-c.js';
import { suiteD } from './suites/suite-d.js';
import { suiteE } from './suites/suite-e.js';
import { suiteF } from './suites/suite-f.js';
import { suiteG } from './suites/suite-g.js';
import { suiteH } from './suites/suite-h.js';
import { suiteI } from './suites/suite-i.js';
import { suiteJ } from './suites/suite-j.js';
import { suiteK } from './suites/suite-k.js';
import { suiteL } from './suites/suite-l.js';
import { suiteM } from './suites/suite-m.js';
import { suiteN } from './suites/suite-n.js';

async function main(): Promise<void> {
  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-${Date.now()}`);

  const ctx: SmokeContext = {
    sourceDir: tmpBase,
    vaultDir: path.join(tmpBase, 'vault'),
    provider1Dir: path.join(tmpBase, 'p1'),
    provider2Dir: path.join(tmpBase, 'p2'),
    provider3Dir: path.join(tmpBase, 'p3'),
    originalHashes: new Map(),
  };

  console.log(`[SMOKE] bin: ${bin}`);
  console.log(`[SMOKE] tmp: ${tmpBase}`);

  let totalFail = 0;

  try {
    await fs.mkdir(ctx.vaultDir, { recursive: true });
    await fs.mkdir(ctx.provider1Dir, { recursive: true });
    await fs.mkdir(ctx.provider2Dir, { recursive: true });
    await fs.mkdir(ctx.provider3Dir, { recursive: true });

    ctx.originalHashes = await createTestFiles(ctx.vaultDir);
    await setupVault(ctx);

    const results = [
      await suiteA(ctx.vaultDir),
      await suiteB(ctx),
      await suiteC(ctx),
      await suiteD(ctx),
      await suiteE(ctx),
      await suiteF(ctx),
      await suiteG(ctx),
      await suiteH(ctx),
      await suiteI(ctx),
      await suiteJ(),
      await suiteK(),
      await suiteL(),
      await suiteM(),
      await suiteN(ctx),
    ];

    let totalPass = 0;
    let totalSkipped = 0;
    for (const suite of results) {
      const { failures, skipped } = printSuite(suite);
      totalFail += failures;
      totalSkipped += skipped;
      totalPass += suite.tests.length - failures - skipped;
    }

    console.log(
      `\n[SMOKE] Results: ${totalPass} PASS, ${totalFail} FAIL, ${totalSkipped} SKIP`,
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    '[SMOKE] Fatal error:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
