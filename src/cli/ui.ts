import chalk from 'chalk';
import { t } from '../i18n/index.js';
import { VersionHealth } from '../types/index.js';

// ─── Color helpers ────────────────────────────────────────────────────────────

/** Prints a success message in green. */
export function success(msg: string): void {
  console.log(chalk.green(`✓ ${msg}`));
}

/** Prints an error message in red. */
export function error(msg: string): void {
  console.error(chalk.red(`✗ ${msg}`));
}

/**
 * Thrown when a command fails after already displaying an error message.
 * Signals the REPL to suppress further output and return to the prompt,
 * and signals standalone mode to exit with code 1.
 */
export class CommandAbort extends Error {
  constructor() {
    super('');
    this.name = 'CommandAbort';
  }
}

/** Prints a warning message in yellow. */
export function warn(msg: string): void {
  console.warn(chalk.yellow(`⚠ ${msg}`));
}

/** Prints an info message. */
export function info(msg: string): void {
  console.log(chalk.cyan(`  ${msg}`));
}

// ─── Box drawing ──────────────────────────────────────────────────────────────

/**
 * Renders text inside a box with a title.
 * @param title - Box title shown on the top border
 * @param lines - Content lines inside the box
 */
export function box(title: string, lines: string[]): void {
  const maxLen = Math.max(
    title.length,
    ...lines.map((l) => stripAnsi(l).length),
  );
  const width = maxLen + 4;
  const top = `┌${'─'.repeat(width)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;
  const titleLine = `│ ${chalk.bold(title)}${' '.repeat(width - title.length - 1)}│`;
  const sep = `├${'─'.repeat(width)}┤`;

  console.log(chalk.dim(top));
  console.log(chalk.dim('│') + titleLine.slice(1, -1) + chalk.dim('│'));
  console.log(chalk.dim(sep));
  for (const line of lines) {
    const pad = width - stripAnsi(line).length - 1;
    console.log(`${chalk.dim('│')} ${line}${' '.repeat(pad)}${chalk.dim('│')}`);
  }
  console.log(chalk.dim(bottom));
}

// ─── Table ────────────────────────────────────────────────────────────────────

/**
 * Renders a simple ASCII table.
 * @param headers - Column header names
 * @param rows    - Row data (string arrays, same length as headers)
 */
export function table(headers: string[], rows: string[][]): void {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );

  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const headerRow =
    '|' +
    headers.map((h, i) => ` ${chalk.bold(h.padEnd(widths[i]))} `).join('|') +
    '|';

  console.log(chalk.dim(sep));
  console.log(headerRow);
  console.log(chalk.dim(sep));
  for (const row of rows) {
    const line =
      '|' +
      Array.from({ length: cols }, (_, i) => {
        const cell = row[i] ?? '';
        const pad = widths[i] - stripAnsi(cell).length;
        return ` ${cell}${' '.repeat(pad)} `;
      }).join('|') +
      '|';
    console.log(line);
  }
  console.log(chalk.dim(sep));
}

// ─── Health formatting ────────────────────────────────────────────────────────

/** Returns a colored health string with icon. */
export function formatHealth(health: VersionHealth): string {
  switch (health) {
    case VersionHealth.Healthy:
      return chalk.green(t('health_healthy'));
    case VersionHealth.Degraded:
      return chalk.yellow(t('health_degraded'));
    case VersionHealth.Damaged:
      return chalk.red(t('health_damaged'));
    case VersionHealth.Unknown:
      return chalk.gray(t('health_unknown'));
  }
}

/** Formats bytes to human-readable string (KB, MB, GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Strips ANSI escape codes from a string for length calculation. */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
