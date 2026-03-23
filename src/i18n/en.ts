import type { Strings } from './index.js';

export const en: Strings = {
  // ─── REPL ────────────────────────────────────────────────────────────────
  repl_banner_title: '\n  BFS — Backup File System\n',
  repl_no_config: '  No configuration. Use `init` to get started.',
  repl_banner_hint: '\n  Type `help` to see available commands.\n',
  repl_help_header: '\n  Available commands:\n',
  repl_help_cmd_init: 'Initialize a new vault',
  repl_help_cmd_push: 'Back up the current directory',
  repl_help_cmd_pull: 'Restore files from backup',
  repl_help_cmd_status: 'Show vault status',
  repl_help_cmd_versions: 'List backup versions',
  repl_help_cmd_prune: 'Delete old versions (e.g. 1-5, --keep-last 3)',
  repl_help_cmd_verify: 'Check shard availability and health',
  repl_help_cmd_recovery: 'Disaster recovery',
  repl_help_cmd_provider_add: 'Add a provider',
  repl_help_cmd_provider_list: 'List providers',
  repl_help_cmd_provider_remove: 'Remove a provider',
  repl_help_cmd_scheme_set: 'Change Reed-Solomon scheme (N data + K parity)',
  repl_help_cmd_help: 'Show this help',
  repl_help_cmd_exit: 'Exit',
  repl_goodbye: 'Goodbye!',
  repl_cancelled: 'Cancelled.',

  // ─── Health ──────────────────────────────────────────────────────────────
  health_healthy: '✓ healthy',
  health_degraded: '⚠ degraded',
  health_damaged: '✗ damaged',
  health_unknown: '? unknown',

  // ─── Command descriptions (bfs --help) ───────────────────────────────────
  cmd_bfs_desc:
    'Backup File System — distributed backup with Reed-Solomon erasure coding',
  cmd_version_flag: 'Show program version',
  cmd_help_flag: 'Display help for command',
  cmd_help_cmd: 'Display help for command',
  cmd_cwd_desc: 'Vault working directory (overrides current directory)',
  cmd_lang_desc: 'Set UI language permanently (e.g. en, pl)',
  cmd_init_desc: 'Initialize a new vault in the current directory',
  cmd_push_desc: 'Back up the current directory (new version or overwrite)',
  cmd_pull_desc: 'Restore files from backup',
  cmd_status_desc: 'Show vault status',
  cmd_versions_desc: 'List all backup versions',
  cmd_prune_desc: 'Delete old backup versions from providers',
  cmd_verify_desc: 'Check shard availability and health for all versions',
  cmd_recovery_desc: 'Rebuild .bfs/ from providers (disaster recovery)',
  cmd_scheme_desc: 'Manage the vault Reed-Solomon scheme',
  cmd_scheme_set_desc:
    'Change the N/K scheme (provider count must equal data+parity)',
  cmd_provider_desc: 'Manage providers',
  cmd_provider_add_desc: 'Add a new provider to the vault configuration',
  cmd_provider_list_desc: 'List configured providers',
  cmd_provider_remove_desc: 'Remove or replace a provider (with heal option)',

  // ─── Global / shared ─────────────────────────────────────────────────────
  global_settings_group: 'BFS Settings (global)',
  lang_set: 'Language set to: %s',
  no_config: 'No vault configuration found. Run `bfs init` first.',
  cancelled: 'Cancelled.',
  required: 'Required',
  path_required: 'Path is required',
  path_not_dir: 'Path is not a directory',
  dir_not_exist: 'Directory does not exist: %s',

  // ─── init ─────────────────────────────────────────────────────────────────
  init_header: '\n  BFS — vault initialization\n',
  init_provider_header: '\nProvider %s:',
  init_provider_name_prompt: 'Provider name (e.g. usb-drive, local-nas):',
  init_provider_name_required: 'Name is required',
  init_provider_type_prompt: 'Provider type:',
  init_dir_path_prompt: 'Directory path:',
  init_vault_name_prompt: 'Vault name (= subfolder on providers):',
  init_vault_name_required: 'Name is required',
  init_scanning: 'Scanning directory…',
  init_found_files: 'Found %s file(s) (%s)',
  init_enc_prompt: 'Enable AES-256-GCM encryption?',
  init_data_shards_prompt: 'Number of data shards N (min. 2):',
  init_data_shards_min: 'Minimum 2 data shards',
  init_parity_shards_prompt: 'Number of parity shards K (min. 1):',
  init_parity_shard_min: 'Minimum 1 parity shard',
  init_providers_needed: '\nNeed %s providers (%s data + %s parity)\n',
  init_push_mode_prompt: 'Push mode:',
  init_push_mode_new: 'new_version — each push creates a new version (default)',
  init_push_mode_overwrite: 'overwrite — overwrite the current version',
  init_push_mode_ask: 'ask — ask every time',
  init_push_mode_invalid:
    'Invalid --push-mode: "%s". Allowed: new_version|overwrite|ask',
  init_provider_format_invalid:
    'Invalid --provider format: "%s". Expected: type:id:path (e.g. local:myusb:/mnt/usb)',
  init_success: 'Vault "%s" initialized. Use `bfs push` to back up.',

  // ─── push ─────────────────────────────────────────────────────────────────
  push_preparing: 'Preparing push…',
  push_completed: 'Push completed',
  push_success: 'Backup uploaded to all providers.',
  push_failed: 'Push failed',

  // ─── pull ─────────────────────────────────────────────────────────────────
  pull_preparing: 'Preparing pull…',
  pull_completed: 'Pull completed',
  pull_success: 'Files restored.',
  pull_failed: 'Pull failed',

  // ─── status ───────────────────────────────────────────────────────────────
  status_header: '\n  Vault status\n',
  status_name: 'Name:',
  status_latest: 'Latest:',
  status_on_disk: 'On disk:',
  status_scheme: 'Scheme:',
  status_encryption: 'Encryption:',
  status_providers: 'Providers:',
  status_enc_enabled: 'enabled',
  status_enc_disabled: 'disabled',

  // ─── versions ─────────────────────────────────────────────────────────────
  versions_empty:
    'No versions found. Use `bfs push` to create the first backup.',
  versions_col_version: 'Version',
  versions_col_status: 'Status',
  versions_col_scheme: 'Scheme',
  versions_col_shards: 'Shards',
  versions_col_files: 'Files',
  versions_col_size: 'Size',
  versions_col_pushed_at: 'Pushed at',

  // ─── prune ────────────────────────────────────────────────────────────────
  prune_no_versions: 'No versions to delete.',
  prune_keep_last_invalid: '--keep-last must be a number >= 1',
  prune_range_manual: 'Enter range manually (e.g. 1-5, 1,3,5)',
  prune_select_prompt: 'Select versions to delete:',
  prune_range_prompt: 'Version range (e.g. 1-5 or 1,3,5):',
  prune_no_selected: 'No versions selected.',
  prune_no_in_range: 'No versions in the given range.',
  prune_versions_to_delete: 'Versions to delete: %s',
  prune_confirm: 'Delete %s version(s)?',
  prune_deleted: 'Deleted versions: %s',

  // ─── verify ───────────────────────────────────────────────────────────────
  verify_spinner: 'Verifying versions…',
  verify_no_versions: 'No versions to verify.',
  verify_failed: 'Verification failed',
  verify_col_version: 'Version',
  verify_col_status: 'Status',
  verify_col_available: 'Available',
  verify_col_scheme: 'Scheme',
  verify_col_tolerance: 'Tolerance',

  // ─── recovery ─────────────────────────────────────────────────────────────
  recovery_provider_type_prompt: 'Bootstrap provider type:',
  recovery_path_prompt: 'Provider base path (not the vault subfolder):',
  recovery_vault_name_prompt: 'Vault name (subfolder on providers):',
  recovery_connecting: 'Connecting to provider…',
  recovery_scanning: 'Scanning providers…',
  recovery_rebuilt: '\n  Rebuilt .bfs/ — %s version(s)\n',
  recovery_col_version: 'Version',
  recovery_col_status: 'Status',
  recovery_col_consensus: 'Consensus',
  recovery_success:
    'Use `bfs pull` to restore files (default: latest version).',
  recovery_failed: 'Recovery failed',

  // ─── scheme ───────────────────────────────────────────────────────────────
  scheme_data_shards_invalid: 'Data shards must be an integer >= 2.',
  scheme_parity_shards_invalid: 'Parity shards must be an integer >= 1.',
  scheme_requires:
    'Scheme %s/%s requires %s providers, currently configured: %s.',
  scheme_add_providers:
    'Add %s provider(s) via `provider add`, then change the scheme.',
  scheme_remove_providers:
    'Remove %s provider(s) via `provider remove`, then change the scheme.',
  scheme_changed: 'Scheme changed: %s → %s/%s.',
  scheme_apply_push: 'Run `bfs push` to apply the new scheme.',

  // ─── provider add ─────────────────────────────────────────────────────────
  provider_add_current: '\nCurrent providers (%s):',
  provider_add_warn:
    'Adding a provider changes the N+K scheme. Run `bfs push` after adding to update sharding.',
  provider_add_id_required: '--id is required in CI mode',
  provider_add_path_required: '--path is required for type=local in CI mode',
  provider_add_name_prompt: 'New provider name:',
  provider_add_name_required: 'Name is required',
  provider_add_exists: 'Provider "%s" already exists',
  provider_add_type_prompt: 'Provider type:',
  provider_add_dir_prompt: 'Directory path:',
  provider_add_success:
    'Provider "%s" added. Scheme: %s/%s. Run `bfs push` to apply the new scheme.',

  // ─── provider list ────────────────────────────────────────────────────────
  provider_list_empty: 'No providers configured.',
  provider_list_header: '\nProviders for vault "%s" (scheme %s/%s):\n',
  provider_list_col_num: '#',
  provider_list_col_id: 'ID',
  provider_list_col_type: 'Type',
  provider_list_col_config: 'Configuration',

  // ─── provider remove ──────────────────────────────────────────────────────
  provider_remove_no_providers: 'No providers in configuration.',
  provider_remove_prompt: 'Which provider to remove?',
  provider_remove_not_found:
    'Provider "%s" does not exist. Use `provider list` to see available names or indices.',
  provider_remove_impact: 'Provider "%s" is used in %s version(s):',
  provider_remove_impact_warn:
    'After removal: healthy versions will become degraded, degraded may become damaged.',
  provider_remove_strategy_prompt: 'Choose a strategy:',
  provider_remove_strategy_relocate:
    '[R]elocate — shard exists, provider changed address (new IP/host/path)',
  provider_remove_strategy_rebuild:
    '[R]ebuild — shard lost, rebuild from RS and upload to another provider',
  provider_remove_strategy_remove:
    '[R]emove — remove provider without replacement, update N/K scheme',
  provider_remove_strategy_cancel: '[C]ancel',
  provider_remove_new_path_required:
    '--new-path is required for relocate strategy in CI mode',
  provider_remove_new_path_prompt: 'New provider directory path:',
  provider_remove_enc_password_relocate:
    'Encryption password (to update location map):',
  provider_remove_enc_password_rebuild:
    'Encryption password (to read/write location map):',
  provider_remove_rebuild_scope_prompt: 'Which versions to rebuild?',
  provider_remove_rebuild_all: '[A]ll versions using this provider',
  provider_remove_rebuild_latest: '[L]atest version only',
  provider_remove_no_other_providers:
    'No other providers available for rebuild.',
  provider_remove_target_prompt:
    'Which provider to upload the rebuilt shard to?',
  provider_remove_yes_required:
    '--yes is required for remove strategy in CI mode',
  provider_remove_confirm:
    'Remove provider "%s" without rebuilding? Versions will be degraded.',
  provider_remove_scope_invalid: 'Invalid --scope: "%s". Allowed: all|latest',
  provider_remove_target_required:
    '--target is required for rebuild strategy in CI mode',
  provider_remove_target_invalid:
    'Provider "%s" does not exist or is the same as the one being removed',
  provider_remove_success: 'Provider "%s" removed.',
  provider_remove_next_steps: 'Recommended next steps:',
  provider_remove_next_step_1: '  1. `bfs pull` — fetch the current version',
  provider_remove_next_step_2: '  2. `bfs push` — create a new healthy backup',
  provider_remove_next_step_3:
    '  3. `bfs prune` — optionally delete old degraded versions',
  provider_relocate_success: 'Provider "%s" relocated.',
  provider_rebuild_success:
    'Provider "%s" replaced. Run `bfs push` to update the scheme.',
};
