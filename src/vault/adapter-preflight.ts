import { ProviderError } from '../core/errors.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ProviderConfig } from '../types/index.js';

/**
 * A provider type used in a vault configuration for which the corresponding
 * adapter is not registered in the current BFS process. Grouped per type —
 * multiple provider entries sharing the same unregistered type produce a
 * single MissingAdapter with all affected provider ids listed.
 */
export interface MissingAdapter {
  readonly type: string;
  /** npm spec recorded in ProviderConfig.adapterPackage; null = built-in. */
  readonly adapterPackage: Nullable<string>;
  /** Provider names that use this missing type. */
  readonly providerIds: readonly string[];
}

/**
 * A type whose adapter IS registered, but the installed version does not
 * match the version recorded when the backup was produced.
 */
export interface VersionMismatch {
  readonly type: string;
  /** Full npm spec recorded with the backup, e.g. "bfs-adapter-x@1.0.1". */
  readonly recordedPackage: string;
  /** Currently installed npm spec, derived from registry meta. */
  readonly installedPackage: string;
  /**
   * `strong` = major version delta (likely breaking config format);
   * `soft`   = minor or patch delta (should be backwards compatible).
   */
  readonly severity: 'soft' | 'strong';
  /** Provider names that use this mismatching type. */
  readonly providerIds: readonly string[];
}

/**
 * Finds every provider type referenced by the given configuration for which
 * {@link providerRegistry} has no factory. Groups results by type so one
 * missing adapter used by N providers is reported once with all ids.
 *
 * Built-in types (ftp, local) only end up here when BFS itself was built
 * without them — a pathological case indicating a broken installation, not
 * a plugin gap.
 */
export function detectMissingAdapters(providers: readonly ProviderConfig[]): MissingAdapter[] {
  const missing = new Map<string, { adapterPackage: Nullable<string>; providerIds: string[] }>();
  for (const p of providers) {
    if (providerRegistry.has(p.type)) continue;
    const entry = missing.get(p.type);
    if (entry) {
      entry.providerIds.push(p.id);
      continue;
    }
    missing.set(p.type, { adapterPackage: p.adapterPackage, providerIds: [p.id] });
  }
  return [...missing.entries()].map(([type, { adapterPackage, providerIds }]) => ({ type, adapterPackage, providerIds }));
}

/**
 * Renders a human-readable install script for a set of missing adapters.
 * Skips built-in misses (they deserve a separate hard error, not a hint).
 */
export function formatMissingAdaptersMessage(missing: readonly MissingAdapter[]): string {
  const external = missing.filter((m) => m.adapterPackage !== null);
  if (external.length === 0) return '';
  const lines: string[] = [t('adapter_preflight_missing_header'), ''];
  const maxTypeLen = external.reduce((max, m) => Math.max(max, m.type.length), 0);
  const installLabel = t('adapter_preflight_install_label');
  for (const m of external) {
    lines.push(`  ${m.type.padEnd(maxTypeLen)}   — ${installLabel} npm install -g ${m.adapterPackage}`);
  }
  lines.push('', t('adapter_preflight_retry_hint'));
  return lines.join('\n');
}

/**
 * Factory for a ProviderError that describes one unregistered type. Used by
 * call sites that encounter an unknown type outside the pull/recovery
 * preflight (where a batch report is preferred).
 */
export function missingAdapterError(type: string, adapterPackage: Nullable<string>): ProviderError {
  if (adapterPackage === null) {
    return new ProviderError(fmt('adapter_preflight_builtin_broken_one', type));
  }
  return new ProviderError(fmt('adapter_preflight_external_install_hint', type, adapterPackage, adapterPackage));
}

/**
 * Detects configurations whose recorded adapter version differs from the
 * currently installed one. Ignores providers with no `adapterPackage`
 * (built-ins) and providers whose type is missing from the registry (those
 * are reported by {@link detectMissingAdapters}).
 */
export function checkVersionMismatch(providers: readonly ProviderConfig[]): VersionMismatch[] {
  const grouped = new Map<string, { recorded: string; providerIds: string[] }>();
  for (const p of providers) {
    if (p.adapterPackage === null) continue;
    if (!providerRegistry.has(p.type)) continue;
    const installedMeta = providerRegistry.getMeta(p.type);
    if (installedMeta === null) continue;
    const installed = `${installedMeta.packageName}@${installedMeta.packageVersion}`;
    if (p.adapterPackage === installed) continue;
    const key = `${p.type}\0${p.adapterPackage}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.providerIds.push(p.id);
      continue;
    }
    grouped.set(key, { recorded: p.adapterPackage, providerIds: [p.id] });
  }
  const mismatches: VersionMismatch[] = [];
  for (const [key, { recorded, providerIds }] of grouped) {
    const type = key.split('\0')[0] ?? '';
    const installedMeta = providerRegistry.getMeta(type);
    if (installedMeta === null) continue;
    const installed = `${installedMeta.packageName}@${installedMeta.packageVersion}`;
    const severity = compareSeverity(recorded, installed);
    mismatches.push({ type, recordedPackage: recorded, installedPackage: installed, severity, providerIds });
  }
  return mismatches;
}

/**
 * Decides whether a recorded/installed delta should warn loudly or quietly.
 * Major version difference → `strong` (likely breaking config format).
 * Different package names → `strong` (wholesale replacement).
 * Minor/patch difference → `soft` (should be backwards compatible under semver).
 * Unparseable versions → `strong` (fail loud rather than silently downgrade).
 */
function compareSeverity(recorded: string, installed: string): 'soft' | 'strong' {
  const r = splitSpec(recorded);
  const i = splitSpec(installed);
  if (r === null || i === null) return 'strong';
  if (r.name !== i.name) return 'strong';
  return r.major === i.major ? 'soft' : 'strong';
}

/**
 * Parses a pinned npm spec into its package name and major version. Accepts
 * scoped names ("@corp/pkg@1.2.3") and unscoped ("pkg@1.2.3"). Pre-release
 * tags ("1.2.3-beta.1") are allowed — only the leading integer matters.
 */
function splitSpec(spec: string): Nullable<{ name: string; major: number }> {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const majorStr = version.split('.')[0] ?? '';
  const major = Number.parseInt(majorStr, 10);
  if (!Number.isFinite(major)) return null;
  return { name, major };
}
