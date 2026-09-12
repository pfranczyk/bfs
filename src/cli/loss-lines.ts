import { fmt, type Strings } from '../i18n/index.js';
import type { ShardLossCause, VersionLoss } from '../vault/verify.js';
import { warn } from './ui.js';

/**
 * The sentence naming each cause of loss. Five of them are the ones a failed
 * restore already prints for the same state, so the commands that report a loss
 * cannot end up describing one switched-off drive in different words.
 */
const LOSS_CAUSE_KEYS: Record<ShardLossCause, keyof Strings> = {
  data_corrupt: 'loss_on_damaged',
  file_missing: 'loss_on_missing',
  medium_unreachable: 'loss_on_unreachable',
  adapter_missing: 'loss_on_adapter_missing',
  provider_not_configured: 'loss_on_not_configured',
  read_failed: 'loss_on_read_failed',
  header_mismatch: 'loss_on_header_mismatch',
};

/**
 * The label a version carries in a table and in every line about it.
 *
 * @param version - Version number
 * @returns the zero-padded label, e.g. `v007`
 */
export function versionLabel(version: number): string {
  return `v${String(version).padStart(3, '0')}`;
}

/**
 * Prints why the listed versions are short of parts - one line per cause and
 * version, naming every medium behind it under the names the backup records.
 *
 * Grouped rather than one line per part: the count is what the operator reads
 * first, and a wide pool losing three parts to one dead switch has one thing to
 * fix, not three. A version that lost nothing contributes no line.
 *
 * @param versions - Per-version loss causes, in the order they should be printed
 */
export function warnLossCauses(versions: ReadonlyArray<{ version: number; loss_causes: readonly VersionLoss[] }>): void {
  for (const v of versions) {
    for (const loss of v.loss_causes) {
      warn(fmt('verify_loss_line', versionLabel(v.version), fmt(LOSS_CAUSE_KEYS[loss.cause], loss.providers.join(', '))));
    }
  }
}
