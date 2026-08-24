/**
 * Shared gate for the "unconfirmed config after recovery" defense.
 *
 * `recover()` rebuilds .bfs/config.json from a shard's location map - unkeyed on
 * a `--no-enc` backup - and marks state.locations_confirmed=false, unless the
 * operator pre-approved those locations with `bfs recovery --trust-locations`,
 * which records them as already confirmed. Every write path that
 * authenticates to providers from that config (push, and the heal strategies in
 * removeProvider) must show the operator where data will go and require
 * confirmation BEFORE contacting any host - defending against a recovered config
 * pointing at an attacker host.
 */

import { BfsError } from '../core/errors.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ProviderIO, VaultConfig } from '../types/index.js';

/**
 * Shows the operator each provider's recovered location and requires
 * confirmation before any provider is contacted. The location string is
 * produced by the provider's own describeConfig (BFS is blind to which fields
 * are host vs secret; describeConfig masks secrets). Throws to abort on denial.
 *
 * @throws BfsError when the operator declines the confirmation.
 */
export async function confirmRecoveredLocations(config: VaultConfig, io: ProviderIO): Promise<void> {
  io.info(t('push_recovered_locations_intro'));
  for (const pc of config.providers) {
    let where = pc.type;
    try {
      where = providerRegistry.create(pc, io).describeConfig(pc.config);
    } catch {
      // unknown adapter - fall back to the provider type alone
    }
    io.info(fmt('push_recovered_location', pc.id, where));
  }
  // With nobody there the confirmation answers itself with "no", and reporting
  // that as a refusal dead-ends the operator: retrying changes nothing, because
  // only a confirmed write or a fresh recovery with --trust-locations clears the
  // flag. Say which of those it takes instead - and say it only here, since an
  // operator who did refuse must not be handed the command that overrides them.
  if (io.interactive === false) throw new BfsError(t('push_recovered_locations_no_operator'));
  const ok = await io.confirm(t('push_confirm_recovered_locations'));
  if (!ok) throw new BfsError(t('push_recovered_locations_declined'));
}
