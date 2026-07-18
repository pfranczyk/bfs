import { describe, expect, it } from 'vitest';
// Side-effect import: register built-in providers so `local:` / `ftp:` migration
// prefixes resolve the same way the production CLI does.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';
import { parseRepairSpec } from '../../src/cli/parse-provider-spec.js';
import { createCliProviderIO } from '../../src/providers/provider.js';

const CWD = process.cwd();
const existing = ['local-1', 'local-2', 'ftp-1'];
// Non-interactive IO (workDir = CWD) — parseRepairSpec forwards it to each
// adapter's configureFromFlags; the spec parsing itself issues no prompts.
const io = createCliProviderIO(CWD, false);

describe('parseRepairSpec', () => {
  it('should reject an odd number of positional arguments', async () => {
    await expect(parseRepairSpec(['local-1', '--path E:/', 'local-2'], existing, io)).rejects.toThrow();
  });

  it('should reject an empty argument list', async () => {
    await expect(parseRepairSpec([], existing, io)).rejects.toThrow();
  });

  it('should reject an unknown provider name', async () => {
    await expect(parseRepairSpec(['ghost', '--path E:/'], existing, io)).rejects.toThrow();
  });

  it('should parse a single same-id edit pair', async () => {
    const pairs = await parseRepairSpec(['local-1', '--path E:/'], existing, io);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].oldName).toBe('local-1');
    expect(pairs[0].isMigration).toBe(false);
    expect(pairs[0].newConfig).toBeNull();
    expect(pairs[0].rawParams).toEqual(['--path', 'E:/']);
  });

  it('should treat empty params as a no-op edit (valid, e.g. paired with --rebuild)', async () => {
    const pairs = await parseRepairSpec(['local-1', ''], existing, io);

    expect(pairs[0].isMigration).toBe(false);
    expect(pairs[0].rawParams).toEqual([]);
  });

  it('should detect a type:name migration and build its config', async () => {
    const pairs = await parseRepairSpec(['local-1', `local:local-3 --path ${CWD}`], existing, io);

    expect(pairs[0].isMigration).toBe(true);
    expect(pairs[0].newConfig?.id).toBe('local-3');
    expect(pairs[0].newConfig?.type).toBe('local');
  });

  it('should chunk multiple pairs', async () => {
    const pairs = await parseRepairSpec(['local-1', '--path E:/', 'ftp-1', '--password secret'], existing, io);

    expect(pairs).toHaveLength(2);
    expect(pairs[1].oldName).toBe('ftp-1');
    expect(pairs[1].rawParams).toEqual(['--password', 'secret']);
  });

  it('should reject a duplicate old provider name in arguments', async () => {
    await expect(parseRepairSpec(['local-1', '--path E:/', 'local-1', '--path Z:/'], existing, io)).rejects.toThrow();
  });

  it('should reject a migration targeting an existing provider id', async () => {
    await expect(parseRepairSpec(['local-1', 'ftp:local-2 --host h --user u --password p --path /b'], existing, io)).rejects.toThrow();
  });

  it('should reject two pairs migrating to the same new id', async () => {
    await expect(parseRepairSpec(['local-1', 'ftp:shared --host h --user u --password p --path /b', 'local-2', 'ftp:shared --host h2 --user u --password p --path /c'], existing, io)).rejects.toThrow();
  });

  it('should reject params that are neither flags nor a valid migration', async () => {
    await expect(parseRepairSpec(['local-1', 'garbage token'], existing, io)).rejects.toThrow();
  });
});
