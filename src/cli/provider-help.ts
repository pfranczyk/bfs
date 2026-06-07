import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ProviderHelp, ProviderHelpFlag } from '../types/index.js';

const INDENT_HEADING = '  ';
const INDENT_BODY = '    ';
const INDENT_ITEM = '      ';
const FLAG_COLUMN_GAP = 4;

/**
 * Builds the per-provider help section rendered under `bfs provider -h`.
 * Iterates every registered provider type, asks the factory for its
 * {@link ProviderHelp}, and prints a uniform block per type. BFS prepends
 * `Usage: bfs provider add --name <name> --type <type>` before the
 * provider-specific suffix — adapter authors fill fields, not free text.
 *
 * When the registry is empty (no providers registered — should not happen
 * in practice because built-in `local` and `ftp` register at import time),
 * returns an empty string so Commander's own help remains unchanged.
 *
 * @returns multi-line help block starting with a leading newline, or empty
 *          string when no providers are registered
 */
export function buildProviderHelpSection(): string {
  const types = providerRegistry.listTypes();
  if (types.length === 0) return '';

  const blocks: string[] = [];
  for (const { type, displayName } of types) {
    const factory = providerRegistry.getFactory(type);
    if (!factory) continue;
    const help = factory.help();
    const installHint = resolveInstallHint(type, help);
    blocks.push(renderProviderSection(type, displayName, help, installHint));
  }
  return `\n${t('provider_help_available_header')}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * Resolves the "install: ..." hint shown next to a provider's heading.
 * Precedence:
 *   1. {@link ProviderHelp.installation} — adapter's own custom text.
 *   2. Registry meta → `npm install -g <packageName>` (no version in help
 *      because help is generic; version lives in ProviderConfig.adapterPackage
 *      per provider instance).
 *   3. null for built-ins without meta.
 */
function resolveInstallHint(type: string, help: ProviderHelp): Nullable<string> {
  if (typeof help.installation === 'string' && help.installation.length > 0) {
    return help.installation;
  }
  const meta = providerRegistry.getMeta(type);
  if (meta !== null) return `npm install -g ${meta.packageName}`;
  return null;
}

/**
 * Assembles one provider block: heading, Usage line, description, Options
 * table, Examples. Sections with empty content are omitted.
 */
function renderProviderSection(type: string, displayName: string, help: ProviderHelp, installHint: Nullable<string>): string {
  const headingSuffix = installHint !== null ? `  ${fmt('provider_help_install_hint', installHint)}` : '';
  const heading = `${INDENT_HEADING}${type} — ${displayName}${headingSuffix}`;

  const usageSuffix = help.usage.length > 0 ? ` ${help.usage}` : '';
  const usageLine = `${INDENT_BODY}${t('provider_help_usage_label')} bfs provider add --name <name> --type ${type}${usageSuffix}`;

  const description = indent(help.description, INDENT_BODY);

  const sections: string[] = [heading, usageLine, description];
  if (help.flags.length > 0) {
    sections.push(`${INDENT_BODY}${t('provider_help_options_label')}\n${renderFlagsTable(help.flags)}`);
  }
  if (help.examples.length > 0) {
    const examples = help.examples.map((e) => indent(e, INDENT_ITEM)).join('\n');
    sections.push(`${INDENT_BODY}${t('provider_help_example_label')}\n${examples}`);
  }
  return sections.join('\n\n');
}

/**
 * Renders the provider flags list with the flag column left-padded to the
 * longest flag's length (+ {@link FLAG_COLUMN_GAP} spaces), so descriptions
 * align vertically regardless of how many entries the provider declared.
 */
function renderFlagsTable(flags: readonly ProviderHelpFlag[]): string {
  const maxFlagLen = flags.reduce((max, f) => Math.max(max, f.flag.length), 0);
  const columnWidth = maxFlagLen + FLAG_COLUMN_GAP;
  return flags.map((f) => `${INDENT_ITEM}${f.flag.padEnd(columnWidth)}${f.description}`).join('\n');
}

/**
 * Prefixes every line of `text` with `prefix`. Preserves blank lines verbatim
 * so multi-paragraph descriptions render with consistent indentation.
 */
function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n');
}
