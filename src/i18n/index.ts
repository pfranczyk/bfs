import { en } from './en.js';
import { pl } from './pl.js';

/** All translatable strings used by the BFS CLI. */
export interface Strings {
  // ─── REPL ────────────────────────────────────────────────────────────────
  repl_banner_title: string;
  repl_no_config: string;
  repl_banner_hint: string;
  repl_help_header: string;
  repl_help_cmd_init: string;
  repl_help_cmd_push: string;
  repl_help_cmd_pull: string;
  repl_help_cmd_status: string;
  repl_help_cmd_versions: string;
  repl_help_cmd_prune: string;
  repl_help_cmd_verify: string;
  repl_help_cmd_recovery: string;
  repl_help_cmd_repair: string;
  repl_help_cmd_provider_add: string;
  repl_help_cmd_provider_list: string;
  repl_help_cmd_provider_remove: string;
  repl_help_cmd_scheme_set: string;
  repl_help_cmd_clear: string;
  repl_help_cmd_help: string;
  repl_help_cmd_exit: string;
  repl_goodbye: string;
  repl_cancelled: string;
  /** %s = provider count */
  repl_banner_providers: string;
  /** %s = error message */
  repl_error_prefix: string;

  // ─── Health ──────────────────────────────────────────────────────────────
  health_healthy: string;
  health_degraded: string;
  health_damaged: string;
  health_unknown: string;

  // ─── Command descriptions (bfs --help) ───────────────────────────────────
  cmd_bfs_desc: string;
  cmd_version_flag: string;
  cmd_help_flag: string;
  cmd_help_cmd: string;
  cmd_cwd_desc: string;
  cmd_lang_desc: string;
  cmd_init_desc: string;
  cmd_push_desc: string;
  cmd_pull_desc: string;
  cmd_status_desc: string;
  cmd_versions_desc: string;
  cmd_prune_desc: string;
  cmd_verify_desc: string;
  cmd_recovery_desc: string;
  cmd_scheme_desc: string;
  cmd_scheme_set_desc: string;
  cmd_provider_desc: string;
  cmd_provider_add_desc: string;
  cmd_provider_list_desc: string;
  cmd_provider_remove_desc: string;
  cmd_provider_edit_desc: string;

  // ─── Global / shared ─────────────────────────────────────────────────────
  global_settings_group: string;
  lang_set: string;
  no_config: string;
  cancel: string;
  cancelled: string;
  required: string;
  path_required: string;
  path_not_dir: string;
  /** %s = path */
  dir_not_exist: string;

  // ─── init ─────────────────────────────────────────────────────────────────
  init_header: string;
  /** %s = provider number */
  init_provider_header: string;
  init_provider_name_prompt: string;
  init_provider_name_required: string;
  init_provider_type_prompt: string;
  init_dir_path_prompt: string;
  /** %s = provider id */
  probe_connection: string;
  /** %s = provider id, %s = error message */
  probe_failed: string;
  /** %s = provider id, %s = validation errors */
  probe_validate_failed: string;
  probe_failed_prompt: string;
  probe_choice_retry: string;
  probe_choice_reenter: string;
  probe_choice_abort: string;
  init_opt_ci: string;
  init_opt_enc: string;
  init_opt_no_enc: string;
  init_opt_no_compress: string;
  init_opt_compress: string;
  init_opt_data_shards: string;
  init_opt_parity_shards: string;
  init_opt_provider: string;
  init_opt_push_mode: string;
  init_vault_name_arg: string;
  init_vault_name_prompt: string;
  init_vault_name_required: string;
  init_scanning: string;
  /** %s = count, %s = size */
  init_found_files: string;
  init_enc_prompt: string;
  init_compress_prompt: string;
  /** %s = ratio%, %s = top extensions */
  init_compress_scanning: string;
  /** %s = ratio percent, %s = top extensions list */
  init_compress_skip_suggest: string;
  init_compress_auto_on: string;
  init_data_shards_prompt: string;
  init_data_shards_min: string;
  init_parity_shards_prompt: string;
  init_parity_shard_min: string;
  /** %s = total, %s = data, %s = parity */
  init_providers_needed: string;
  init_push_mode_prompt: string;
  init_push_mode_new: string;
  init_push_mode_overwrite: string;
  init_push_mode_ask: string;
  /** %s = mode */
  init_push_mode_invalid: string;
  /** %s = spec */
  init_provider_format_invalid: string;
  /** %s = reasons */
  init_provider_config_invalid: string;
  /** %s = detected MB */
  init_max_ram_prompt: string;
  init_opt_max_ram: string;
  /** %s = vaultName */
  init_success: string;
  init_ci_name_required: string;
  init_ci_scheme_required: string;
  /** %s = supplied value */
  init_ci_data_shards_invalid: string;
  /** %s = supplied value */
  init_ci_parity_shards_invalid: string;
  /** %s = required total, %s = N, %s = K */
  init_ci_providers_required: string;

  // ─── clear ────────────────────────────────────────────────────────────────
  cmd_clear_desc: string;
  clear_done: string;
  /** %s = filename (e.g. "push.lock") */
  clear_removed_file: string;

  // ─── config ───────────────────────────────────────────────────────────────
  cmd_config_desc: string;
  config_current_settings: string;
  config_updated: string;
  config_reset: string;
  config_reset_no_field: string;
  /** %s = flag name (twice) */
  config_dir_hint: string;
  config_opt_cache_dir: string;
  config_opt_temp_dir: string;
  config_opt_max_ram: string;
  config_opt_reset: string;
  /** %s = feature name (compress, encryption) */
  config_opt_on: string;
  /** %s = feature name (compress, encryption) */
  config_opt_off: string;
  /** %s = feature display name */
  config_feature_on: string;
  /** %s = feature display name */
  config_feature_off: string;
  /** %s = unknown feature name */
  config_feature_unknown: string;
  config_next_push: string;
  config_label_compression: string;
  config_label_encryption: string;
  /** %s = default cache path */
  config_cache_default: string;
  config_temp_default: string;
  config_ram_auto: string;

  // ─── push ─────────────────────────────────────────────────────────────────
  push_preparing: string;
  push_completed: string;
  push_success: string;
  push_failed: string;
  /** %s = count */
  push_skipped_header: string;
  push_cache_hint: string;
  /** %s = version, %s = uploaded count, %s = total (N+K) */
  push_completed_healthy: string;
  /** %s = version, %s = uploaded count, %s = total (N+K) */
  push_partial_degraded: string;
  /** %s = version, %s = uploaded count, %s = required (N), %s = version (repeated for prune hint) */
  push_damaged: string;
  push_opt_new: string;
  push_opt_overwrite: string;
  push_opt_password: string;
  push_opt_cache: string;
  push_opt_max_ram: string;
  push_opt_no_compress: string;
  push_opt_compress: string;
  push_compress_conflict: string;
  push_opt_allow_drift: string;
  push_drift_label_changed: string;
  push_drift_label_vanished: string;
  push_drift_label_appeared: string;
  /** %s = count, %s = file list */
  push_drift_confirm: string;
  /** %s = count, %s = file list */
  push_drift_accepted: string;
  /** %s = count */
  push_drift_header: string;
  push_drift_hint: string;
  vault_compressing: string;
  vault_decompressing: string;
  opt_temp_dir_desc: string;
  opt_cache_dir_desc: string;

  // ─── lockfile / push partial ─────────────────────────────────────────────
  /** %s = operation ('push' or 'repair'), %s = PID, %s = started_at ISO timestamp */
  lock_concurrent_active: string;
  /** %s = version */
  lock_partial_state_push: string;
  /** %s = comma-separated list of missing files */
  push_cache_no_lock: string;
  /** %s = error message from the failed write */
  push_cache_write_failed: string;
  push_cache_unavailable_in_lock: string;

  // ─── pull ─────────────────────────────────────────────────────────────────
  pull_preparing: string;
  pull_completed: string;
  pull_success: string;
  pull_failed: string;
  /** %s = count */
  pull_skipped_header: string;
  pull_cache_hint: string;
  pull_opt_version: string;
  pull_opt_force: string;
  pull_opt_yes: string;
  pull_opt_password: string;
  pull_opt_provider: string;
  pull_opt_path: string;
  pull_opt_name: string;
  pull_opt_cache: string;
  pull_opt_allow_missing_adapters: string;

  // ─── status ───────────────────────────────────────────────────────────────
  status_header: string;
  status_name: string;
  status_latest: string;
  status_on_disk: string;
  status_scheme: string;
  status_encryption: string;
  status_providers: string;
  status_enc_enabled: string;
  status_enc_disabled: string;
  /** %s = data_shards, %s = parity_shards */
  status_push_disabled_warn: string;
  /** %s = data_shards, %s = parity_shards */
  status_scheme_breakdown: string;

  // ─── versions ─────────────────────────────────────────────────────────────
  versions_empty: string;
  versions_col_version: string;
  versions_col_status: string;
  versions_col_scheme: string;
  versions_col_shards: string;
  versions_col_files: string;
  versions_col_size: string;
  versions_col_pushed_at: string;

  // ─── prune ────────────────────────────────────────────────────────────────
  prune_opt_keep_last: string;
  prune_opt_yes: string;
  /** %s = range string */
  prune_range_invalid: string;
  /** %s = version string */
  prune_version_format_invalid: string;
  prune_no_versions: string;
  prune_keep_last_invalid: string;
  prune_range_manual: string;
  prune_select_prompt: string;
  prune_range_prompt: string;
  prune_no_selected: string;
  prune_no_in_range: string;
  /** %s = versions list */
  prune_versions_to_delete: string;
  /** %s = count */
  prune_confirm: string;
  /** %s = versions list */
  prune_deleted: string;
  /** %s = version number, %s = provider/storage name */
  prune_orphan_warn: string;

  // ─── verify ───────────────────────────────────────────────────────────────
  verify_spinner: string;
  verify_no_versions: string;
  verify_failed: string;
  verify_col_version: string;
  verify_col_status: string;
  verify_col_available: string;
  verify_col_scheme: string;
  verify_col_tolerance: string;
  verify_shard_check_failed: string;
  verify_header_advisory: string;

  // ─── recovery ─────────────────────────────────────────────────────────────
  recovery_provider_type_prompt: string;
  recovery_path_prompt: string;
  recovery_opt_provider: string;
  recovery_opt_bootstrap: string;
  recovery_vault_name_prompt: string;
  recovery_opt_name: string;
  recovery_opt_password: string;
  recovery_opt_allow_missing_adapters: string;
  recovery_opt_trust_locations: string;
  /** %s = raw spec */
  recovery_bootstrap_empty: string;
  /** %s = validation errors joined */
  recovery_bootstrap_config_invalid: string;
  /** %s = provider type */
  recovery_provider_type_unknown: string;
  recovery_ci_provider_required: string;
  recovery_ci_name_required: string;
  recovery_connecting: string;
  recovery_scanning: string;
  /** %s = count */
  recovery_rebuilt: string;
  recovery_col_version: string;
  recovery_col_status: string;
  recovery_col_consensus: string;
  recovery_success: string;
  recovery_failed: string;

  // ─── scheme ───────────────────────────────────────────────────────────────
  scheme_data_shards_invalid: string;
  scheme_parity_shards_invalid: string;
  /** %s = N, %s = K, %s = required, %s = current */
  scheme_requires: string;
  /** %s = count */
  scheme_add_providers: string;
  /** %s = count */
  scheme_remove_providers: string;
  /** %s = old, %s = N, %s = K */
  scheme_changed: string;
  scheme_apply_push: string;
  scheme_missing: string;
  /** %s = current value */
  scheme_invalid_data_shards: string;
  /** %s = current value */
  scheme_invalid_parity_shards: string;
  /** %s = required, %s = current */
  scheme_providers_mismatch: string;

  // ─── provider: local-fs ──────────────────────────────────────────────────
  /** %s = basePath */
  provider_local_path_not_exist_confirm: string;
  /** %s = basePath */
  provider_local_path_not_exist_error: string;
  /** %s = basePath */
  provider_local_path_not_writable: string;
  local_path_prompt: string;

  // ─── provider add ─────────────────────────────────────────────────────────
  provider_add_opt_ci: string;
  provider_add_opt_name: string;
  provider_add_opt_type: string;
  /** %s = count */
  provider_add_current: string;
  provider_add_warn: string;
  provider_add_type_required: string;
  provider_add_name_prompt: string;
  provider_add_name_required: string;
  /** %s = id */
  provider_id_invalid_chars: string;
  /** %s = name */
  vault_name_invalid_chars: string;
  /** %s = name */
  provider_add_exists: string;
  /** %s = provider id */
  provider_id_duplicate_in_args: string;
  provider_add_type_prompt: string;
  provider_add_dir_prompt: string;
  /** %s = id, %s = data, %s = parity */
  provider_add_success: string;

  // ─── provider list ────────────────────────────────────────────────────────
  provider_list_empty: string;
  /** %s = vault_name, %s = data, %s = parity */
  provider_list_header: string;
  provider_list_col_num: string;
  provider_list_col_id: string;
  provider_list_col_type: string;
  provider_list_col_config: string;

  // ─── provider remove ──────────────────────────────────────────────────────
  provider_remove_opt_password: string;
  provider_remove_opt_strategy: string;
  provider_remove_opt_new_type: string;
  provider_remove_opt_target: string;
  provider_remove_opt_scope: string;
  provider_remove_opt_yes: string;
  /** %s = strategy string */
  provider_remove_strategy_invalid: string;
  provider_remove_no_providers: string;
  provider_remove_prompt: string;
  /** %s = id */
  provider_remove_not_found: string;
  /** %s = id, %s = count */
  provider_remove_impact: string;
  provider_remove_impact_warn: string;
  provider_remove_strategy_prompt: string;
  provider_remove_strategy_relocate: string;
  provider_remove_strategy_rebuild: string;
  provider_remove_strategy_remove: string;
  provider_remove_strategy_cancel: string;
  provider_remove_new_type_required: string;
  /** %s = current type */
  provider_remove_change_type_confirm: string;
  provider_remove_new_type_prompt: string;
  /** %s = reasons */
  provider_remove_config_invalid: string;
  provider_remove_enc_password_relocate: string;
  provider_remove_enc_password_rebuild: string;
  provider_remove_rebuild_scope_prompt: string;
  provider_remove_rebuild_all: string;
  provider_remove_rebuild_latest: string;
  provider_remove_no_other_providers: string;
  provider_remove_rebuild_new_location: string;
  provider_remove_target_prompt: string;
  provider_remove_yes_required: string;
  /** %s = id */
  provider_remove_confirm: string;
  /** %s = scope */
  provider_remove_scope_invalid: string;
  provider_remove_target_required: string;
  /** %s = target */
  provider_remove_target_invalid: string;
  /** %s = id */
  provider_remove_success: string;
  provider_remove_next_steps: string;
  provider_remove_next_step_1: string;
  provider_remove_next_step_2: string;
  provider_remove_next_step_3: string;
  /** %s = id */
  provider_relocate_success: string;
  /** %s = id */
  provider_rebuild_success: string;

  // ─── provider edit ────────────────────────────────────────────────────────
  provider_edit_opt_ci: string;
  provider_edit_id_required: string;
  /** %s = id */
  provider_edit_not_found: string;
  /** %s = id */
  provider_edit_current: string;
  provider_edit_prompt: string;
  /** %s = error */
  provider_edit_configure_failed: string;
  /** %s = reasons */
  provider_edit_invalid_config: string;
  /** %s = id */
  provider_edit_no_changes: string;
  /** %s = id */
  provider_edit_success: string;
  provider_edit_synced_hint: string;

  // ─── vault operations ────────────────────────────────────────────────────
  /** %s = version */
  vault_download_shards: string;
  /** %s = provider_id, %s = shard_index */
  vault_provider_not_found: string;
  /** %s = shard_index+1 (1-based), %s = N+K total */
  vault_download_shard_progress: string;
  /** %s = provider_id */
  vault_provider_unreachable: string;
  /** %s = provider_id */
  vault_file_missing_on_provider: string;
  /** %s = provider_id */
  vault_provider_adapter_missing: string;
  vault_decoding_rs: string;
  vault_ask_decrypt_password: string;
  vault_decrypting: string;
  /** %s = working_version, %s = latest_version, %s = targetVersion */
  vault_push_version_confirm: string;
  vault_using_cached_blob: string;
  vault_no_cached_blob_push: string;
  /** %s = count, %s = file list */
  vault_push_skipped_confirm: string;
  vault_ask_encrypt_password: string;
  vault_ask_confirm_password: string;
  vault_encrypting: string;
  vault_password_overrides_config: string;
  vault_unencrypted_warning: string;
  /** %s = per-unit encryption limit in GiB */
  gcm_payload_too_large: string;
  /** %s = data count N, %s = total N+K */
  push_damaged_zero: string;
  push_cancelled: string;
  vault_password_required: string;
  vault_passwords_mismatch: string;
  push_no_config: string;
  push_recovered_locations_intro: string;
  /** %s = provider name, %s = location description */
  push_recovered_location: string;
  push_confirm_recovered_locations: string;
  push_recovered_locations_declined: string;
  // ─── vault — pull / versions / provider runtime ──────────────────────────
  /** %s = data count N (need), %s = available/found count (got) */
  pull_not_enough_shards: string;
  pull_blob_size_unreadable: string;
  pull_salt_missing: string;
  /** %s = provider name, %s = piece index */
  pull_provider_not_found_skip: string;
  /** %s = piece index */
  pull_shard_header_invalid_skip: string;
  /** %s = piece index */
  pull_shard_hash_mismatch_skip: string;
  pull_degraded_repair: string;
  /** %s = required provider count (N+K), %s = given count */
  scheme_provider_count_mismatch: string;
  pull_cancelled: string;
  pull_blob_hash_mismatch: string;
  pull_no_config: string;
  no_versions_available: string;
  /** %s = version number */
  version_not_found: string;
  /** %s = provider name */
  provider_not_found_in_config: string;
  provider_remove_min: string;
  vault_encoding_rs: string;
  vault_uploading_shards: string;
  /** %s = i+1 (1-based), %s = N+K total */
  vault_upload_shard_progress: string;
  /** %s = shard index (1-based), %s = total (N+K), %s = error detail */
  vault_upload_shard_failed: string;
  vault_no_cached_blob_pull: string;
  /** %s = working_version, %s = targetVersion */
  vault_pull_overwrite_confirm: string;
  vault_unpacking_files: string;
  /** %s = count, %s = file list */
  vault_pull_write_error_confirm: string;
  vault_degraded_provider_unreachable: string;
  vault_degraded_file_missing: string;
  vault_degraded_adapter_missing: string;
  vault_degraded_corrupt: string;

  // ─── recovery operations (vault layer) ──────────────────────────────────
  recovery_ask_version_password: string;
  recovery_pool_password_failed: string;
  recovery_wrong_password_retry: string;
  recovery_decrypt_skip: string;
  recovery_ask_transport_password: string;

  // ─── bootstrap operations ────────────────────────────────────────────────
  bootstrap_ask_password: string;
  bootstrap_wrong_password_retry: string;
  bootstrap_single_provider_warn: string;

  // ─── provider: ftp ──────────────────────────────────────────────────────
  ftp_host_prompt: string;
  ftp_port_prompt: string;
  ftp_user_prompt: string;
  ftp_password_prompt: string;
  ftp_path_prompt: string;
  ftp_secure_prompt: string;
  provider_add_ftp_ci_not_supported: string;

  // ─── provider help (bfs provider -h) ─────────────────────────────────────
  // Frame strings (BFS-internal, used by provider-help.ts)
  provider_help_available_header: string;
  provider_help_usage_label: string;
  provider_help_options_label: string;
  provider_help_example_label: string;
  /** %s = install command (e.g. "npm install -g foo") */
  provider_help_install_hint: string;

  // Built-in local provider — description + flag descriptions
  local_help_description: string;
  local_help_flag_path_desc: string;
  local_help_flag_config_file_desc: string;

  // Built-in ftp provider — description + flag descriptions
  ftp_help_description: string;
  ftp_help_flag_host_desc: string;
  ftp_help_flag_port_desc: string;
  ftp_help_flag_user_desc: string;
  ftp_help_flag_password_desc: string;
  ftp_help_flag_path_desc: string;
  ftp_help_flag_secure_desc: string;
  ftp_help_flag_config_file_desc: string;

  // ─── Provider configuration errors ───────────────────────────────────────
  ftp_host_required: string;
  ftp_path_required: string;
  ftp_path_must_be_absolute: string;
  local_config_path_missing: string;

  // ─── Adapter preflight (missing / version mismatch) ──────────────────────
  adapter_preflight_missing_header: string;
  adapter_preflight_install_label: string;
  adapter_preflight_retry_hint: string;
  /** %s = type */
  adapter_preflight_builtin_broken_one: string;
  /** %s = quoted, comma-joined types */
  adapter_preflight_builtin_broken_many: string;
  /** %s = type, %s = packageSpec, %s = packageSpec */
  adapter_preflight_external_install_hint: string;
  /** %s = type, %s = recorded, %s = installed, %s = recorded */
  adapter_version_mismatch_strong: string;
  /** %s = type, %s = recorded, %s = installed */
  adapter_version_mismatch_soft: string;

  // ─── Generic provider errors (CLI side) ──────────────────────────────────
  /** %s = type */
  provider_type_unknown: string;
  /** %s = err.message */
  provider_add_configure_failed: string;
  /** %s = errors joined */
  provider_add_validate_failed: string;
  /** %s = err.message */
  provider_add_probe_failed: string;
  provider_add_probe_unsaved: string;

  // ─── Recovery (consensus + final) ────────────────────────────────────────
  /** %s = version */
  recovery_consensus_vault_id_mismatch: string;
  /** %s = version */
  recovery_consensus_filename_mismatch: string;
  /** %s = version, %s = mismatched fields */
  recovery_consensus_failed: string;
  recovery_no_manifests: string;
  /** %s = version */
  recovery_manifest_unreadable: string;

  // ─── Provider runtime errors (FTP + LocalFS shared shape) ────────────────
  /** %s = path */
  provider_short_shard: string;
  /** %s = path, %s = err */
  provider_stat_failed: string;
  /** %s = path, %s = err */
  provider_header_read_failed: string;
  /** %s = value */
  provider_download_header_invalid_max_bytes: string;
  /** %s = provider type, %s = missing method, %s = provider API version */
  provider_adapter_incompatible: string;
  /** %s = path */
  verify_shard_not_found: string;
  /** %s = field, %s = expected, %s = actual */
  verify_shard_mismatch: string;
  /** %s = provider id, %s = path */
  verify_shard_auth_failed: string;
  /** %s = path, %s = detail */
  verify_shard_corrupted: string;
  /** %s = provider id, %s = path */
  verify_shard_unverifiable: string;

  // ─── FTP — runtime errors ────────────────────────────────────────────────
  /** %s = host, %s = port, %s = err */
  ftp_operation_failed: string;
  /** %s = label, %s = attempt, %s = max, %s = sent, %s = reported */
  ftp_size_mismatch_attempt: string;
  /** %s = label, %s = max, %s = sent, %s = reported, %s = diff */
  ftp_size_mismatch_final: string;
  /** %s = host:port */
  ftp_insecure_warning: string;
  ftp_control_chars: string;
  /** %s = host[:port], %s = path */
  ftp_recovery_confirm_host: string;
  /** %s = host[:port], %s = path */
  ftp_recovery_target: string;
  /** %s = host[:port] */
  ftp_recovery_password: string;
  /** %s = host[:port] */
  ftp_recovery_declined: string;

  // ─── FTP — configureFromFlags + validateConfig ───────────────────────────
  ftp_config_port_invalid: string;
  ftp_inline_port_invalid: string;
  ftp_inline_secure_invalid: string;
  ftp_validate_host_required: string;
  ftp_validate_port_invalid: string;
  ftp_validate_path_required: string;
  ftp_validate_path_absolute: string;
  /** %s = host, %s = port, %s = user, %s = path, %s = secure */
  ftp_describe_config: string;

  // ─── FTP — probeConnection ───────────────────────────────────────────────
  ftp_probe_incomplete: string;
  /** %s = err */
  ftp_probe_step_ensure_dir: string;
  /** %s = err */
  ftp_probe_step_upload: string;
  /** %s = err */
  ftp_probe_step_download: string;
  ftp_probe_step_compare_remote: string;
  /** %s = err */
  ftp_probe_step_cleanup: string;

  // ─── provider: ssh ──────────────────────────────────────────────────────
  ssh_host_prompt: string;
  ssh_port_prompt: string;
  ssh_user_prompt: string;
  ssh_auth_method_prompt: string;
  ssh_auth_password: string;
  ssh_auth_key: string;
  ssh_password_prompt: string;
  ssh_private_key_prompt: string;
  ssh_passphrase_prompt: string;
  ssh_path_prompt: string;
  ssh_host_key_confirm: string;
  ssh_host_key_declined: string;
  /** %s = user@host:port */
  ssh_host_key_revoked: string;
  /** %s = user@host:port */
  ssh_edit_connecting: string;
  /** %s = host:port */
  ssh_edit_offline_menu: string;
  ssh_edit_offline_paste: string;
  ssh_edit_paste_prompt: string;
  ssh_edit_fingerprint_invalid: string;
  /** %s = key type, %s = fingerprint */
  ssh_edit_offline_known_hosts_entry: string;
  /** %s = key type, %s = fingerprint */
  ssh_edit_offline_known_hosts_entry_recommended: string;
  ssh_edit_offline_no_pin: string;
  ssh_edit_no_pin_warn: string;
  ssh_edit_offline_exit: string;
  ssh_edit_cancelled: string;
  ssh_help_description: string;
  ssh_help_flag_host_desc: string;
  ssh_help_flag_port_desc: string;
  ssh_help_flag_user_desc: string;
  ssh_help_flag_password_desc: string;
  ssh_help_flag_private_key_desc: string;
  ssh_help_flag_passphrase_desc: string;
  ssh_help_flag_path_desc: string;
  ssh_help_flag_known_host_desc: string;
  ssh_help_flag_accept_new_host_key_desc: string;
  ssh_help_flag_config_file_desc: string;
  ssh_operation_failed: string;
  ssh_size_mismatch: string;
  ssh_control_chars: string;
  ssh_key_unreadable: string;
  ssh_recovery_confirm_host: string;
  ssh_recovery_target: string;
  ssh_recovery_password: string;
  ssh_recovery_passphrase: string;
  ssh_recovery_declined: string;
  ssh_recovery_no_secret_noninteractive: string;
  ssh_recovery_unpinned: string;
  ssh_config_port_invalid: string;
  ssh_inline_port_invalid: string;
  ssh_host_required: string;
  ssh_path_required: string;
  ssh_path_must_be_absolute: string;
  ssh_auth_conflict: string;
  ssh_auth_missing: string;
  ssh_accept_new_offline: string;
  ssh_validate_host_required: string;
  ssh_validate_port_invalid: string;
  ssh_validate_path_required: string;
  ssh_validate_path_absolute: string;
  ssh_validate_auth_required: string;
  ssh_validate_auth_conflict: string;
  ssh_describe_config: string;
  ssh_probe_incomplete: string;
  ssh_probe_step_ensure_dir: string;
  ssh_probe_step_upload: string;
  ssh_probe_step_download: string;
  ssh_probe_step_compare_remote: string;
  ssh_probe_step_cleanup: string;

  // ─── LocalFS — runtime errors ────────────────────────────────────────────
  /** %s = path, %s = err */
  local_list_failed: string;
  /** %s = path, %s = err */
  local_list_vaults_failed: string;
  /** %s = path, %s = err */
  local_update_header_failed: string;
  /** %s = path, %s = err */
  local_read_shard_failed: string;

  // ─── LocalFS — validateConfig + describeConfig ───────────────────────────
  local_validate_path_required: string;
  /** %s = path */
  local_describe_config: string;

  // ─── LocalFS — probeConnection ───────────────────────────────────────────
  local_probe_incomplete: string;
  /** %s = err */
  local_probe_step_mkdir: string;
  /** %s = err */
  local_probe_step_write: string;
  /** %s = err */
  local_probe_step_read: string;
  local_probe_step_compare_local: string;
  /** %s = err */
  local_probe_step_cleanup: string;

  // ─── repair (spec parsing) ─────────────────────────────────────────────────
  repair_spec_odd_args: string;
  /** %s = provider id */
  repair_unknown_provider: string;
  /** %s = provider id */
  repair_duplicate_provider_in_args: string;
  /** %s = params string */
  repair_spec_invalid_params: string;
  /** %s = provider/storage name */
  heal_locationmap_update_failed: string;
  heal_relocate_unreachable: string;

  // ─── repair (command) ──────────────────────────────────────────────────────
  cmd_repair_desc: string;
  repair_opt_version: string;
  repair_opt_password: string;
  repair_opt_password_file: string;
  repair_opt_ci: string;
  repair_opt_rebuild: string;
  repair_opt_force_unverified: string;
  repair_no_versions: string;
  /** %s = version */
  repair_foreign_shard_detected: string;
  /** %s = version */
  repair_wrong_version_shard: string;
  /** %s = version */
  repair_force_unverified_warn: string;
  /** %s = version */
  repair_ask_vault_password: string;
  /** %s = version */
  repair_wrong_vault_password_retry: string;
  /** %s = version */
  repair_pool_password_failed: string;
  /** %s = version */
  repair_password_required_ci: string;
  /** %s = version */
  repair_password_exhausted: string;
  /** %s = errors */
  repair_edit_invalid_config: string;
  /** %s = provider names */
  repair_success: string;
  repair_opt_restore_headers: string;
  repair_restore_headers_success: string;
  repair_restore_headers_no_pairs: string;
  repair_restore_headers_rebuild_conflict: string;
  /** %s = failed provider names */
  repair_partial: string;
}

const translations: Record<string, Strings> = { en, pl };

let currentLang = 'en';

/**
 * Sets the active language for all subsequent t() calls.
 * Falls back to 'en' if the language is not available.
 * @param lang - BCP 47 language tag (e.g. 'en', 'pl')
 */
export function setLang(lang: string): void {
  if (translations[lang]) {
    currentLang = lang;
  } else {
    currentLang = 'en';
  }
}

/** Returns the currently active language tag. */
export function getLang(): string {
  return currentLang;
}

/**
 * Returns the translation for the given key in the active language.
 * @param key - Key from the Strings interface
 */
export function t(key: keyof Strings): string {
  return (translations[currentLang] ?? translations.en)[key];
}

/**
 * Returns the translation for the given key in an explicit language.
 * Used by built-in provider factories which read `factory.lang` (set by
 * BFS via `providerRegistry.setLang()`) instead of relying on the global
 * `currentLang`. Falls back to English when the requested lang is unknown.
 *
 * @param lang - BCP 47 language tag (e.g. 'en', 'pl')
 * @param key  - Key from the Strings interface
 */
export function tFor(lang: string, key: keyof Strings): string {
  return (translations[lang] ?? translations.en)[key];
}

/**
 * Returns a translated string with %s placeholders replaced by the given args.
 * @param key  - Key from the Strings interface
 * @param args - Values to substitute for each %s in order
 */
export function fmt(key: keyof Strings, ...args: string[]): string {
  let s = t(key);
  for (const arg of args) {
    s = s.replace('%s', arg);
  }
  return s;
}

/**
 * Returns a translated string with %s placeholders, in an explicit language.
 * Used by built-in provider adapters which read `factory.lang` / `io.lang`
 * instead of relying on the global `currentLang`.
 *
 * @param lang - BCP 47 language tag (e.g. 'en', 'pl')
 * @param key  - Key from the Strings interface
 * @param args - Values to substitute for each %s in order
 */
export function fmtFor(lang: string, key: keyof Strings, ...args: string[]): string {
  let s = tFor(lang, key);
  for (const arg of args) {
    s = s.replace('%s', arg);
  }
  return s;
}
