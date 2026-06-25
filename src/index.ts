// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025  <Paweł Franczyk>

import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { isPromptCancellation } from './cli/prompt.js';

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../package.json') as { version: string };

// Side-effect imports: register providers in the global registry
import './providers/local-fs.js';
import './providers/ftp.js';
import { registerClear } from './cli/commands/clear.js';
import { registerConfig } from './cli/commands/config.js';
import { registerInit } from './cli/commands/init.js';
import { registerProviderAdd } from './cli/commands/provider-add.js';
import { registerProviderEdit } from './cli/commands/provider-edit.js';
import { registerProviderList } from './cli/commands/provider-list.js';
import { registerProviderRemove } from './cli/commands/provider-remove.js';
import { registerPrune } from './cli/commands/prune.js';
import { registerPull } from './cli/commands/pull.js';
import { registerPush } from './cli/commands/push.js';
import { registerRecovery } from './cli/commands/recovery.js';
import { registerScheme } from './cli/commands/scheme.js';
import { registerStatus } from './cli/commands/status.js';
import { registerVerify } from './cli/commands/verify.js';
import { registerVersions } from './cli/commands/versions.js';
import { buildProviderHelpSection } from './cli/provider-help.js';
import { startRepl } from './cli/repl.js';
import { CommandAbort } from './cli/ui.js';
import { dbg, enableDebug } from './debug.js';
import { readGlobalSettings, writeGlobalSettings } from './global/settings.js';
import { fmt, setLang, t } from './i18n/index.js';
import { providerRegistry } from './providers/provider.js';

/**
 * Applies exitOverride() recursively to a command and all its sub-commands.
 * Commander copies _exitCallback only when sub-commands are created, so calling
 * exitOverride() on the root after registration does not reach sub-commands.
 */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) {
    applyExitOverride(sub);
  }
}

// Build Commander program
function buildProgram(): Command {
  const program = new Command();
  program
    .name('bfs')
    .version(PKG_VERSION, '-V', t('cmd_version_flag'))
    .helpOption('-h, --help', t('cmd_help_flag'))
    .helpCommand('help [command]', t('cmd_help_cmd'))
    .description(t('cmd_bfs_desc'))
    .allowUnknownOption(false)
    .option('--cwd <dir>', t('cmd_cwd_desc'))
    .optionsGroup(t('global_settings_group'))
    .option('--lang <code>', t('cmd_lang_desc'));

  // Register all commands
  registerInit(program);
  registerClear(program);
  registerConfig(program);
  registerPush(program);
  registerPull(program);
  registerStatus(program);
  registerVersions(program);
  registerPrune(program);
  registerVerify(program);
  registerRecovery(program);
  registerScheme(program);

  // Provider sub-commands
  const providerCmd = program.command('provider').description(t('cmd_provider_desc'));
  registerProviderAdd(providerCmd);
  registerProviderList(providerCmd);
  registerProviderEdit(providerCmd);
  registerProviderRemove(providerCmd);
  // Append per-provider help aggregation after Commander's standard preamble.
  // Each registered provider contributes a structured ProviderHelp block.
  providerCmd.addHelpText('after', buildProviderHelpSection);

  return program;
}

async function main(): Promise<void> {
  // Undocumented --debug flag: strip it before Commander sees it, enable debug output.
  const debugIdx = process.argv.indexOf('--debug');
  if (debugIdx !== -1) {
    enableDebug();
    process.argv.splice(debugIdx, 1);
    dbg('debug mode enabled', { node: process.version, argv: process.argv });
  }

  // --lang: pre-scan before Commander to set language before buildProgram().
  // buildProgram() registers .description(t('...')) calls, so language must be
  // active before that. Strip --lang from argv to avoid Commander double-parsing.
  const langIdx = process.argv.indexOf('--lang');
  const cliLang = langIdx !== -1 ? process.argv[langIdx + 1] : undefined;
  if (langIdx !== -1) {
    process.argv.splice(langIdx, cliLang !== undefined ? 2 : 1);
  }

  const settings = await readGlobalSettings();
  const activeLang = cliLang ?? settings.language ?? 'en';
  setLang(activeLang);
  providerRegistry.setLang(activeLang);

  if (cliLang !== undefined) {
    if (cliLang !== settings.language) {
      await writeGlobalSettings({ ...settings, language: cliLang });
    }
    console.log(fmt('lang_set', cliLang));
  }

  // If --lang was the only argument (nothing left after stripping), exit now.
  if (cliLang !== undefined && process.argv.slice(2).length === 0) {
    return;
  }

  // If no sub-command given → start interactive REPL.
  // Filter out --cwd and its value before checking for subcommand tokens.
  // Also treat --help/-h and --version/-V as "has subcommand" so Commander handles them.
  const argv = process.argv.slice(2);
  const nonOptionArgs = argv.filter((a, i, arr) => {
    if (a === '--cwd') return false;
    if (i > 0 && arr[i - 1] === '--cwd') return false;
    return !a.startsWith('-');
  });
  const hasGlobalFlag = argv.some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-V');
  const hasSubcommand = nonOptionArgs.length > 0 || hasGlobalFlag;

  if (!hasSubcommand) {
    // Pre-scan --cwd from argv to set REPL rootDir without full Commander parsing.
    const cwdIdx = process.argv.indexOf('--cwd');
    const cwdValue = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : undefined;
    const rootDir = cwdValue ? path.resolve(cwdValue) : process.cwd();

    await startRepl(rootDir, async (tokens) => {
      // Re-parse each REPL command as if it were argv.
      const replProgram = buildProgram();
      // exitOverride must be applied recursively: sub-commands copy _exitCallback
      // only at creation time, so calling it on the root after buildProgram() would
      // leave sub-commands (e.g. `provider`) with _exitCallback=null → process.exit()
      applyExitOverride(replProgram);
      // Propagate --cwd into REPL commands so resolveCwd() uses the correct rootDir.
      const augmented = rootDir !== process.cwd() ? ['--cwd', rootDir, ...tokens] : tokens;
      await replProgram.parseAsync(['node', 'bfs', ...augmented]);
    });
  } else {
    const program = buildProgram();
    await program.parseAsync(process.argv);
  }
}

main().catch((err) => {
  if (err instanceof CommandAbort) {
    process.exit(1);
  }
  if (isPromptCancellation(err)) {
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
