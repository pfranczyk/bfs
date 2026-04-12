import type { Strings } from './index.js';

export const en: Strings = {
  // ─── REPL ────────────────────────────────────────────────────────────────
  repl_banner_title: '\n  BFS — Backup File System\n',
  repl_no_config: '  No configuration. Use `init` to get started.',
  repl_banner_hint: '\n  Type `help` to see available commands.\n',
  repl_help_header: '\n  Available commands:\n',
  repl_help_cmd_init: 'Set up a new backup',
  repl_help_cmd_push: 'Back up the current directory',
  repl_help_cmd_pull: 'Restore files from backup',
  repl_help_cmd_status: 'Show backup status',
  repl_help_cmd_versions: 'List backup versions',
  repl_help_cmd_prune: 'Delete old versions (e.g. 1-5, --keep-last 3)',
  repl_help_cmd_verify: 'Check shard availability and health',
  repl_help_cmd_recovery: 'Disaster recovery',
  repl_help_cmd_provider_add: 'Add a provider',
  repl_help_cmd_provider_list: 'List providers',
  repl_help_cmd_provider_remove: 'Remove a provider',
  repl_help_cmd_scheme_set: 'Change Reed-Solomon scheme (N data + K parity)',
  repl_help_cmd_clear: 'Delete cached data from interrupted push/pull',
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
  cmd_cwd_desc: 'Backup working directory (overrides current directory)',
  cmd_lang_desc: 'Set UI language permanently (e.g. en, pl)',
  cmd_init_desc: 'Set up a new backup in the current directory',
  cmd_push_desc: 'Back up the current directory (new version or overwrite)',
  cmd_pull_desc: 'Restore files from backup',
  cmd_status_desc: 'Show backup status',
  cmd_versions_desc: 'List all backup versions',
  cmd_prune_desc: 'Delete old backup versions from providers',
  cmd_verify_desc: 'Check shard availability and health for all versions',
  cmd_recovery_desc: 'Rebuild .bfs/ from providers (disaster recovery)',
  cmd_scheme_desc: 'Manage the Reed-Solomon scheme',
  cmd_scheme_set_desc:
    'Change the N/K scheme (provider count must equal data+parity)',
  cmd_provider_desc: 'Manage providers',
  cmd_provider_add_desc: 'Add a new provider to the backup configuration',
  cmd_provider_list_desc: 'List configured providers',
  cmd_provider_remove_desc: 'Remove or replace a provider (with heal option)',

  // ─── Global / shared ─────────────────────────────────────────────────────
  global_settings_group: 'BFS Settings (global)',
  lang_set: 'Language set to: %s',
  no_config: 'No backup found in this directory. Run `bfs init` first.',
  cancel: 'Cancel',
  cancelled: 'Cancelled.',
  required: 'Required',
  path_required: 'Path is required',
  path_not_dir: 'Path is not a directory',
  dir_not_exist: 'Directory does not exist: %s',

  // ─── init ─────────────────────────────────────────────────────────────────
  init_header: '\n  BFS — backup setup\n',
  init_provider_header: '\nProvider %s:',
  init_provider_name_prompt: 'Provider name (e.g. usb-drive, local-nas):',
  init_provider_name_required: 'Name is required',
  init_provider_type_prompt: 'Provider type:',
  init_dir_path_prompt: 'Directory path:',
  init_opt_ci: 'Non-interactive mode (CI/scripts): skip prompts',
  init_opt_enc:
    'Enable AES-256-GCM encryption (only with --ci, disabled by default)',
  init_opt_no_compress: 'Disable ZIP compression (enabled by default)',
  init_opt_compress: 'Enable ZIP compression (overrides auto-detect)',
  init_opt_data_shards: 'Number of data shards N (CI mode)',
  init_opt_parity_shards: 'Number of parity shards K (CI mode)',
  init_opt_provider:
    'Provider in format type:id:path, e.g. local:usb1:/mnt/usb (repeatable)',
  init_opt_push_mode: 'Push mode: new_version|overwrite|ask (CI mode)',
  init_vault_name_arg: 'Backup name (subfolder on providers)',
  init_vault_name_prompt: 'Backup name (subfolder on providers):',
  init_vault_name_required: 'Name is required',
  init_scanning: 'Scanning directory…',
  init_found_files: 'Found %s file(s) (%s)',
  init_enc_prompt: 'Enable AES-256-GCM encryption?',
  init_compress_prompt: 'Enable ZIP compression?',
  init_compress_scanning: 'Analyzing compressibility…',
  init_compress_skip_suggest:
    'Detected %s% already-compressed data (%s). Compression would not reduce backup size.',
  init_compress_auto_on: 'Compressible data detected — compression recommended',
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
  init_max_ram_prompt:
    'RAM limit for encoding (MB, detected: %sMB, 4096MB is enough):',
  init_opt_max_ram: 'RAM limit for encoding in MB (CI mode)',
  init_success: 'Backup "%s" is ready. Use `bfs push` to back up.',

  // ─── clear ────────────────────────────────────────────────────────────────
  cmd_clear_desc: 'Clear pending backup data cache',
  clear_done: 'Cache cleared.',

  // ─── config ───────────────────────────────────────────────────────────────
  cmd_config_desc: 'View or update backup settings',
  config_current_settings: 'Current settings:',
  config_updated: 'Settings updated.',
  config_reset: 'Setting reset to default.',
  config_reset_no_field:
    'Specify --cache-dir or --temp-dir together with --reset.',
  config_dir_hint:
    'Update with `bfs config --%s <path>` or `bfs config --%s --reset`',
  config_opt_cache_dir: 'Set cache directory (overrides .bfs/cache)',
  config_opt_temp_dir: 'Set temporary files directory (overrides system temp)',
  config_opt_max_ram: 'Set RAM limit for encoding (MB, 0 = auto)',
  config_opt_reset: 'Reset setting to default value',
  config_opt_on: 'Enable feature (compress, encryption)',
  config_opt_off: 'Disable feature (compress, encryption)',
  config_feature_on: '%s enabled.',
  config_feature_off: '%s disabled.',
  config_feature_unknown:
    'Unknown feature: %s. Available: compress, encryption',
  config_next_push: 'Change will take effect on the next push.',
  config_label_compression: 'compression:',
  config_label_encryption: 'encryption:',

  // ─── push ─────────────────────────────────────────────────────────────────
  push_preparing: 'Preparing push…',
  push_completed: 'Push completed',
  push_success: 'Backup uploaded to all providers.',
  push_failed: 'Push failed',
  push_skipped_header: '%s file(s) could not be read and were excluded:',
  push_cache_hint:
    'Backup data cached. Use `bfs push --cache` to upload without re-packing.',
  push_opt_new: 'Force a new version',
  push_opt_overwrite: 'Overwrite the current version',
  push_opt_password: 'Encryption password (skips interactive prompt)',
  push_opt_cache: 'Upload cached backup data from a previous interrupted push',
  push_opt_max_ram: 'Override RAM limit for this push (MB)',
  push_opt_no_compress: 'Disable ZIP compression for this push',
  push_opt_compress: 'Enable ZIP compression for this push',
  push_compress_conflict: 'Cannot use --compress and --no-compress together',
  vault_compressing: 'Compressing…',
  vault_decompressing: 'Decompressing…',
  opt_temp_dir_desc: 'Directory for temporary files during push/pull',
  opt_cache_dir_desc: 'Directory for cached backup data (overrides .bfs/cache)',

  // ─── pull ─────────────────────────────────────────────────────────────────
  pull_preparing: 'Preparing pull…',
  pull_completed: 'Pull completed',
  pull_success: 'Files restored.',
  pull_failed: 'Pull failed',
  pull_skipped_header: '%s file(s) could not be written to disk:',
  pull_cache_hint:
    'Backup data cached. Fix permissions, then use `bfs pull --cache` to retry.',
  pull_opt_version: 'Version number to restore (default: latest)',
  pull_opt_force: 'Overwrite directory without confirmation',
  pull_opt_yes:
    'Auto-confirm overwrite prompt (keeps existing files, unlike --force)',
  pull_opt_password: 'Decryption password (skips interactive prompt)',
  pull_opt_provider: 'Provider type (e.g. local, ssh, ftp)',
  pull_opt_path: 'Provider base path; for remote: user@host/basePath',
  pull_opt_name: 'Backup name (subfolder on the provider)',
  pull_opt_cache:
    'Retry using cached backup data from a previous interrupted pull',

  // ─── status ───────────────────────────────────────────────────────────────
  status_header: '\n  Backup status\n',
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
  prune_opt_keep_last: 'Keep the N most recent versions, delete the rest',
  prune_opt_yes: 'Skip confirmation prompt',
  prune_range_invalid: 'Invalid range: %s',
  prune_version_format_invalid: 'Invalid version format: "%s"',
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
  recovery_opt_provider: 'Bootstrap provider type (e.g. local, ssh, ftp)',
  recovery_opt_path: 'Provider base path; for remote: user@host/basePath',
  recovery_path_prompt: 'Provider base path (not the backup subfolder):',
  recovery_vault_name_prompt: 'Backup name (subfolder on providers):',
  recovery_opt_name: 'Backup name (subfolder on providers)',
  recovery_opt_password: 'Password (for encrypted backup)',
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

  // ─── provider: local-fs ──────────────────────────────────────────────────
  provider_local_path_not_exist_confirm: 'Path "%s" does not exist. Create it?',
  provider_local_path_not_exist_error:
    'Path "%s" does not exist and creation was refused.',
  provider_local_path_not_writable: 'Path "%s" is not writable.',

  // ─── provider add ─────────────────────────────────────────────────────────
  provider_add_opt_ci: 'Non-interactive mode (CI/scripts): skip prompts',
  provider_add_opt_id: 'New provider ID (CI mode)',
  provider_add_opt_type: 'Provider type: local (CI mode)',
  provider_add_opt_path: 'Provider directory path (CI mode, for type=local)',
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
  provider_list_header: '\nProviders for backup "%s" (scheme %s/%s):\n',
  provider_list_col_num: '#',
  provider_list_col_id: 'ID',
  provider_list_col_type: 'Type',
  provider_list_col_config: 'Configuration',

  // ─── provider remove ──────────────────────────────────────────────────────
  provider_remove_opt_password:
    'Encryption password (for rebuild/relocate strategy)',
  provider_remove_opt_strategy:
    'CI strategy: relocate|rebuild|remove (skip prompt)',
  provider_remove_opt_new_path:
    'New provider path for relocate strategy; optionally with type prefix: local:/path (CI mode)',
  provider_remove_opt_new_type:
    'New provider type for relocate strategy (when current type is unknown)',
  provider_remove_opt_target: 'Target provider for rebuild strategy (CI mode)',
  provider_remove_opt_scope: 'Rebuild scope: all|latest (default: all)',
  provider_remove_opt_yes: 'Skip confirmation for remove strategy (CI mode)',
  provider_remove_strategy_invalid:
    'Invalid strategy: "%s". Allowed: relocate|rebuild|remove|cancel',
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
  provider_remove_rebuild_new_location:
    '[N]ew location — add a new provider for the rebuilt backup',
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

  // ─── vault operations ────────────────────────────────────────────────────
  vault_download_shards: 'Downloading shards for version %s…',
  vault_provider_not_found:
    'Provider "%s" not found in config — skipping shard %s',
  vault_download_shard_progress: 'Downloading shard %s/%s',
  vault_provider_unreachable: 'Storage "%s" is not accessible — skipping.',
  vault_file_missing_on_provider:
    'Backup data missing on storage "%s" — skipping.',
  vault_decoding_rs: 'Decoding Reed-Solomon…',
  vault_ask_decrypt_password: 'Enter decryption password:',
  vault_decrypting: 'Decrypting…',
  vault_push_version_confirm:
    'On disk: version %s. Latest: %s. Push will create version %s. Continue?',
  vault_using_cached_blob: 'Using cached blob…',
  vault_no_cached_blob_push: 'No cached blob found — running full pack…',
  vault_push_skipped_confirm:
    '%s file(s) could not be read:\n%s\nContinue without them?',
  vault_ask_encrypt_password: 'Enter encryption password:',
  vault_ask_confirm_password: 'Confirm password:',
  vault_encrypting: 'Encrypting per shard…',
  vault_password_overrides_config:
    'Encryption enabled by --password (config has encryption disabled).',
  vault_encoding_rs: 'Encoding with Reed-Solomon…',
  vault_uploading_shards: 'Uploading shards…',
  vault_upload_shard_progress: 'Uploading shard %s/%s',
  vault_no_cached_blob_pull: 'No cached blob found — running full pull…',
  vault_pull_overwrite_confirm:
    'On disk: version %s. Restoring version %s will overwrite directory. Continue?',
  vault_unpacking_files: 'Unpacking files…',
  vault_pull_write_error_confirm:
    '%s file(s) could not be written:\n%s\nFix permissions, then press Y to retry or N to cancel.',
  vault_degraded_provider_unreachable:
    'Pool degraded: one or more providers are unreachable. Use `bfs provider remove` to replace the provider, then `bfs push` to restore redundancy.',
  vault_degraded_file_missing:
    'Pool degraded: backup data was deleted from a healthy provider. Run `bfs push` to re-create the backup.',

  // ─── recovery operations (vault layer) ──────────────────────────────────
  recovery_ask_version_password:
    'Enter password for this version (or leave blank to skip):',

  // ─── bootstrap operations ────────────────────────────────────────────────
  bootstrap_single_provider_warn:
    'Only 1 provider available — cannot verify consensus. Data may be compromised. Proceeding anyway.',
};
