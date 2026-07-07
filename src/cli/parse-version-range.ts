import { fmt } from '../i18n/index.js';

/**
 * Parses a version range expression into a sorted, deduplicated list of
 * existing version numbers.
 *
 * Grammar:
 *  - `latest`         → the single highest existing version (empty if none)
 *  - `all`            → every existing version
 *  - `5`              → version 5 (when it exists)
 *  - `1-10`           → versions 1..10 (existing subset)
 *  - `1-10,15,20-25`  → union of the parts (existing subset)
 *
 * The result is always intersected with `allVersions` and sorted ascending, so
 * a caller never operates on a version that isn't present. The `all` / `latest`
 * keywords (case-insensitive) are accepted only when `allowKeywords` is set —
 * `bfs prune` leaves them off so its numeric-only grammar is unchanged, while
 * `bfs repair` opts in.
 *
 * @param rangeStr     range expression from a CLI flag/argument
 * @param allVersions  every version that currently exists
 * @param opts         `allowKeywords` enables the `all` / `latest` keywords
 * @returns sorted unique existing versions selected by the expression
 * @throws Error when a token is not a valid number/range (or a keyword while disabled)
 */
export function parseVersionRange(rangeStr: string, allVersions: number[], opts: { allowKeywords?: boolean } = {}): number[] {
  if (opts.allowKeywords) {
    const keyword = rangeStr.trim().toLowerCase();
    if (keyword === 'all') return [...new Set(allVersions)].sort((a, b) => a - b);
    if (keyword === 'latest') return allVersions.length === 0 ? [] : [Math.max(...allVersions)];
  }

  const versions = new Set<number>();
  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10);
      const to = parseInt(rangeMatch[2], 10);
      if (from > to) throw new Error(fmt('prune_range_invalid', trimmed));
      for (let v = from; v <= to; v++) versions.add(v);
    } else if (/^\d+$/.test(trimmed)) {
      versions.add(parseInt(trimmed, 10));
    } else {
      throw new Error(fmt('prune_version_format_invalid', trimmed));
    }
  }

  return [...versions].filter((v) => allVersions.includes(v)).sort((a, b) => a - b);
}
