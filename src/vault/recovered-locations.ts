/**
 * Shared gate for the "unconfirmed config after recovery" defense.
 *
 * `recover()` rebuilds .bfs/config.json from a `--no-enc` shard's UNKEYED
 * location map and marks state.locations_confirmed=false. Every write path that
 * authenticates to providers from that config (push, and the heal strategies in
 * removeProvider) must show the operator where data will go and require
 * confirmation BEFORE contacting any host — defending against a recovered config
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
      // unknown adapter — fall back to the provider type alone
    }
    io.info(fmt('push_recovered_location', pc.id, where));
  }
  const ok = await io.confirm(t('push_confirm_recovered_locations'));
  if (!ok) throw new BfsError(t('push_recovered_locations_declined'));
}
