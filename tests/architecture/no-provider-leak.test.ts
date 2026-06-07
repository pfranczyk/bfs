import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture-as-code test.
 *
 * Enforces the BFS rule from CLAUDE.md / PLAN/index.md:
 * > Provider sam rządzi tym co się u niego dzieje — konfiguracja, prompty,
 * > walidacja, upload/download/verify. BFS core/CLI jest ŚLEPE na konkretne
 * > typy providerów.
 *
 * Any regression that reintroduces provider-specific knowledge into `src/cli/`
 * or `src/core/` surfaces here as a failing assertion with a pointer to the
 * offending file.
 */

const SRC = path.resolve(__dirname, '..', '..', 'src');

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Recursively walk a directory and return all .ts file paths. */
async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results.push(...(await collectTsFiles(full)));
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** Read a file and return lines that match `pattern`, skipping comments. */
async function grepLines(file: string, pattern: RegExp): Promise<Array<{ line: number; text: string }>> {
  const content = await fs.readFile(file, 'utf8');
  const lines = content.split('\n');
  const hits: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    // Skip pure single-line comments — documentation may legitimately mention
    // provider types (e.g. "// e.g. 'ftp' or 'local'"). Block comments with
    // code on the same line are still checked.
    if (trimmed.startsWith('//')) continue;
    if (pattern.test(raw)) {
      hits.push({ line: i + 1, text: trimmed });
    }
  }
  return hits;
}

/**
 * Read a source file, drop `//` comment lines, and return all long-form flag
 * names registered via Commander's `.option('--flag …', …)`. Multi-line
 * `.option(` calls are supported (the first literal after the opening paren is
 * captured).
 */
async function extractOptionFlags(file: string): Promise<string[]> {
  const content = await fs.readFile(file, 'utf8');
  const stripped = content
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l))
    .join('\n');
  const pattern = /\.option\s*\(\s*['"]([^'"]+)['"]/g;
  const flags: string[] = [];
  for (const m of stripped.matchAll(pattern)) {
    const first = m[1]?.split(/\s/)[0];
    if (first) flags.push(first);
  }
  return flags;
}

describe('architecture: provider leak prevention', () => {
  it('src/cli and src/core MUST NOT import concrete provider classes', async () => {
    const cliFiles = await collectTsFiles(path.join(SRC, 'cli'));
    const coreFiles = await collectTsFiles(path.join(SRC, 'core'));
    const files = [...cliFiles, ...coreFiles];

    const violations: Violation[] = [];
    for (const f of files) {
      const hits = await grepLines(f, /\b(FtpProvider|LocalFsProvider|SshProvider)\b/);
      for (const h of hits) {
        violations.push({ file: f, line: h.line, text: h.text });
      }
    }

    expect(violations, `Found ${violations.length} leak(s) — CLI/core must be blind to concrete provider classes:\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n')}`).toEqual([]);
  });

  it('src/cli and src/core MUST NOT contain the literals "ftp" or "local" as provider-type strings', async () => {
    const cliFiles = await collectTsFiles(path.join(SRC, 'cli'));
    const coreFiles = await collectTsFiles(path.join(SRC, 'core'));
    const files = [...cliFiles, ...coreFiles];

    // Provider-type literals appear as 'ftp' / "ftp" / 'local' / "local".
    // We match quoted forms only so unrelated identifier substrings are skipped.
    const pattern = /['"](?:ftp|local)['"]/;

    const violations: Violation[] = [];
    for (const f of files) {
      const hits = await grepLines(f, pattern);
      for (const h of hits) {
        violations.push({ file: f, line: h.line, text: h.text });
      }
    }

    expect(violations, `Found ${violations.length} hardcoded provider-type literal(s) — replace with providerRegistry.listTypes() / getFactory():\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n')}`).toEqual([]);
  });

  it('no file imports src/cli/prompt-ftp.ts (the file must stay deleted)', async () => {
    const allFiles = await collectTsFiles(SRC);

    const violations: Violation[] = [];
    for (const f of allFiles) {
      const hits = await grepLines(f, /prompt-ftp/);
      for (const h of hits) {
        violations.push({ file: f, line: h.line, text: h.text });
      }
    }

    expect(violations, `Found ${violations.length} reference(s) to the deleted prompt-ftp module:\n${violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n')}`).toEqual([]);

    // Verify the file itself is gone.
    await expect(fs.stat(path.join(SRC, 'cli', 'prompt-ftp.ts'))).rejects.toThrow();
  });

  it('provider-add MUST only register the three BFS-level flags (pass-through whitelist)', async () => {
    // Provider-specific flags belong in the adapter's own grammar (consumed
    // from CliProviderInput.rawArgs), never as BFS-level Commander options.
    // Adding a fourth flag here requires a deliberate decision — update this
    // whitelist AND note the exception in CHANGELOG.md / ### Changed.
    const flags = await extractOptionFlags(path.join(SRC, 'cli', 'commands', 'provider-add.ts'));
    expect(flags.sort()).toEqual(['--ci', '--name', '--type']);
  });

  it('init MUST only register the closed set of BFS-level flags (no provider-specific knowledge)', async () => {
    // init takes a fixed set of BFS-level flags. Provider-specific knobs
    // (--host, --port, --path, --config-file, …) must live inside the
    // --provider spec value, which is tokenized shell-style and forwarded
    // to the adapter via rawArgs — never as top-level Commander options.
    const flags = await extractOptionFlags(path.join(SRC, 'cli', 'commands', 'init.ts'));
    expect(flags.sort()).toEqual(['--ci', '--compress', '--data-shards', '--enc', '--max-ram', '--no-compress', '--no-enc', '--parity-shards', '--provider', '--push-mode']);
  });

  it('provider-add and provider-remove MUST enable Commander pass-through (allowUnknownOption + allowExcessArguments)', async () => {
    // Without BOTH calls, adapter-specific flags like `--private-key /path`
    // either fail ("unknown option") or get truncated (value token becomes an
    // "excess positional argument"). The two together are what makes rawArgs
    // pass-through actually work — removing either silently breaks the model.
    const files = [path.join(SRC, 'cli', 'commands', 'provider-add.ts'), path.join(SRC, 'cli', 'commands', 'provider-remove.ts')];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const stripped = content
        .split('\n')
        .map((l) => (l.trim().startsWith('//') ? '' : l))
        .join('\n');
      expect(stripped, `${file} must call .allowUnknownOption(true) to forward adapter flags to rawArgs`).toMatch(/\.allowUnknownOption\s*\(\s*true\s*\)/);
      expect(stripped, `${file} must call .allowExcessArguments(true) so value tokens after unknown flags aren't rejected as excess positional args`).toMatch(/\.allowExcessArguments\s*\(\s*true\s*\)/);
    }
  });

  it('init MUST NOT use Commander pass-through — its flag set is closed and adapter flags go through --provider', async () => {
    // init is NOT a pass-through command at the Commander level. Adapter
    // flags travel inside the `--provider "<type>:<name> [flags]"` value,
    // which is tokenized by shellParse(), not by Commander. Enabling
    // allowUnknownOption here would let BFS-level typos silently succeed.
    const content = await fs.readFile(path.join(SRC, 'cli', 'commands', 'init.ts'), 'utf8');
    const stripped = content
      .split('\n')
      .map((l) => (l.trim().startsWith('//') ? '' : l))
      .join('\n');
    expect(stripped).not.toMatch(/\.allowUnknownOption\s*\(/);
    expect(stripped).not.toMatch(/\.allowExcessArguments\s*\(/);
  });
});
