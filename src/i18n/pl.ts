import type { Strings } from './index.js';

export const pl: Strings = {
  // ─── REPL ────────────────────────────────────────────────────────────────
  repl_banner_title: '\n  BFS — System kopii zapasowych\n',
  repl_no_config: '  Brak konfiguracji. Użyj `init`, aby zacząć.',
  repl_banner_hint: '\n  Wpisz `help`, aby zobaczyć dostępne polecenia.\n',
  repl_help_header: '\n  Dostępne polecenia:\n',
  repl_help_cmd_init: 'Utwórz nowy vault',
  repl_help_cmd_push: 'Utwórz kopię zapasową bieżącego katalogu',
  repl_help_cmd_pull: 'Przywróć pliki z kopii zapasowej',
  repl_help_cmd_status: 'Pokaż status vaulta',
  repl_help_cmd_versions: 'Wylistuj wersje kopii zapasowych',
  repl_help_cmd_prune: 'Usuń stare wersje (np. 1-5, --keep-last 3)',
  repl_help_cmd_verify: 'Sprawdź dostępność i stan shardów',
  repl_help_cmd_recovery: 'Odbudowa po awarii',
  repl_help_cmd_provider_add: 'Dodaj provider',
  repl_help_cmd_provider_list: 'Wylistuj providery',
  repl_help_cmd_provider_remove: 'Usuń provider',
  repl_help_cmd_scheme_set:
    'Zmień schemat Reed-Solomon (N danych + K parzystości)',
  repl_help_cmd_help: 'Pokaż tę pomoc',
  repl_help_cmd_exit: 'Wyjdź',
  repl_goodbye: 'Do widzenia!',
  repl_cancelled: 'Anulowano.',

  // ─── Health ──────────────────────────────────────────────────────────────
  health_healthy: '✓ zdrowy',
  health_degraded: '⚠ degradowany',
  health_damaged: '✗ uszkodzony',
  health_unknown: '? nieznany',

  // ─── Command descriptions (bfs --help) ───────────────────────────────────
  cmd_bfs_desc:
    'Backup File System — rozproszony backup z kodowaniem Reed-Solomon',
  cmd_version_flag: 'Pokaż wersję programu',
  cmd_help_flag: 'Wyświetl pomoc dla komendy',
  cmd_help_cmd: 'Wyświetl pomoc dla komendy',
  cmd_cwd_desc: 'Katalog roboczy vaulta (nadpisuje bieżący katalog)',
  cmd_lang_desc: 'Ustaw język UI na stałe (np. en, pl)',
  cmd_init_desc: 'Zainicjalizuj nowy vault w bieżącym katalogu',
  cmd_push_desc:
    'Utwórz kopię zapasową bieżącego katalogu (nowa wersja lub nadpisanie)',
  cmd_pull_desc: 'Przywróć pliki z kopii zapasowej',
  cmd_status_desc: 'Pokaż status vaulta',
  cmd_versions_desc: 'Wylistuj wszystkie wersje kopii zapasowych',
  cmd_prune_desc: 'Usuń stare wersje kopii zapasowych z providerów',
  cmd_verify_desc: 'Sprawdź dostępność i stan shardów dla wszystkich wersji',
  cmd_recovery_desc: 'Odbuduj .bfs/ z providerów (odtwarzanie po awarii)',
  cmd_scheme_desc: 'Zarządzaj schematem Reed-Solomon vaulta',
  cmd_scheme_set_desc:
    'Zmień schemat N/K (liczba providerów musi być równa data+parity)',
  cmd_provider_desc: 'Zarządzaj providerami',
  cmd_provider_add_desc: 'Dodaj nowy provider do konfiguracji vaulta',
  cmd_provider_list_desc: 'Wylistuj skonfigurowane providery',
  cmd_provider_remove_desc: 'Usuń lub zastąp provider (z opcją naprawy)',

  // ─── Global / shared ─────────────────────────────────────────────────────
  global_settings_group: 'Ustawienia BFS (globalne)',
  lang_set: 'Język ustawiony na: %s',
  no_config: 'Brak konfiguracji vaulta. Uruchom najpierw `bfs init`.',
  cancelled: 'Anulowano.',
  required: 'Wymagane',
  path_required: 'Ścieżka jest wymagana',
  path_not_dir: 'Ścieżka nie jest katalogiem',
  dir_not_exist: 'Katalog nie istnieje: %s',

  // ─── init ─────────────────────────────────────────────────────────────────
  init_header: '\n  BFS — inicjalizacja vaulta\n',
  init_provider_header: '\nProvider %s:',
  init_provider_name_prompt: 'Nazwa providera (np. dysk-usb, nas-lokalny):',
  init_provider_name_required: 'Nazwa jest wymagana',
  init_provider_type_prompt: 'Typ providera:',
  init_dir_path_prompt: 'Ścieżka do katalogu:',
  init_vault_name_prompt: 'Nazwa vaulta (= podfolder na providerach):',
  init_vault_name_required: 'Nazwa jest wymagana',
  init_scanning: 'Skanowanie katalogu…',
  init_found_files: 'Znaleziono %s plik(ów) (%s)',
  init_enc_prompt: 'Włączyć szyfrowanie AES-256-GCM?',
  init_data_shards_prompt: 'Liczba shardów danych N (min. 2):',
  init_data_shards_min: 'Minimum 2 shardy danych',
  init_parity_shards_prompt: 'Liczba shardów parzystości K (min. 1):',
  init_parity_shard_min: 'Minimum 1 shard parzystości',
  init_providers_needed:
    '\nPotrzeba %s providerów (%s danych + %s parzystości)\n',
  init_push_mode_prompt: 'Tryb push:',
  init_push_mode_new: 'new_version — każdy push tworzy nową wersję (domyślnie)',
  init_push_mode_overwrite: 'overwrite — nadpisz bieżącą wersję',
  init_push_mode_ask: 'ask — pytaj za każdym razem',
  init_push_mode_invalid:
    'Nieprawidłowy --push-mode: "%s". Dozwolone: new_version|overwrite|ask',
  init_provider_format_invalid:
    'Nieprawidłowy format --provider: "%s". Oczekiwany: typ:id:ścieżka (np. local:dysk1:/mnt/usb)',
  init_success:
    'Vault "%s" zainicjalizowany. Użyj `bfs push`, aby wykonać kopię.',

  // ─── push ─────────────────────────────────────────────────────────────────
  push_preparing: 'Przygotowanie push…',
  push_completed: 'Push zakończony',
  push_success: 'Kopia zapasowa przesłana na wszystkie providery.',
  push_failed: 'Push nieudany',

  // ─── pull ─────────────────────────────────────────────────────────────────
  pull_preparing: 'Przygotowanie pull…',
  pull_completed: 'Pull zakończony',
  pull_success: 'Pliki przywrócone.',
  pull_failed: 'Pull nieudany',

  // ─── status ───────────────────────────────────────────────────────────────
  status_header: '\n  Status vaulta\n',
  status_name: 'Nazwa:',
  status_latest: 'Najnowsza:',
  status_on_disk: 'Na dysku:',
  status_scheme: 'Schemat:',
  status_encryption: 'Szyfrowanie:',
  status_providers: 'Providery:',
  status_enc_enabled: 'włączone',
  status_enc_disabled: 'wyłączone',

  // ─── versions ─────────────────────────────────────────────────────────────
  versions_empty:
    'Brak wersji. Użyj `bfs push`, aby utworzyć pierwszą kopię zapasową.',
  versions_col_version: 'Wersja',
  versions_col_status: 'Status',
  versions_col_scheme: 'Schemat',
  versions_col_shards: 'Shardy',
  versions_col_files: 'Pliki',
  versions_col_size: 'Rozmiar',
  versions_col_pushed_at: 'Data push',

  // ─── prune ────────────────────────────────────────────────────────────────
  prune_no_versions: 'Brak wersji do usunięcia.',
  prune_keep_last_invalid: '--keep-last musi być liczbą >= 1',
  prune_range_manual: 'Wpisz zakres ręcznie (np. 1-5, 1,3,5)',
  prune_select_prompt: 'Wybierz wersje do usunięcia:',
  prune_range_prompt: 'Zakres wersji (np. 1-5 lub 1,3,5):',
  prune_no_selected: 'Nie wybrano żadnych wersji.',
  prune_no_in_range: 'Brak wersji w podanym zakresie.',
  prune_versions_to_delete: 'Wersje do usunięcia: %s',
  prune_confirm: 'Usunąć %s wersję/wersji?',
  prune_deleted: 'Usunięto wersje: %s',

  // ─── verify ───────────────────────────────────────────────────────────────
  verify_spinner: 'Weryfikacja wersji…',
  verify_no_versions: 'Brak wersji do weryfikacji.',
  verify_failed: 'Weryfikacja nieudana',
  verify_col_version: 'Wersja',
  verify_col_status: 'Status',
  verify_col_available: 'Dostępne',
  verify_col_scheme: 'Schemat',
  verify_col_tolerance: 'Tolerancja',

  // ─── recovery ─────────────────────────────────────────────────────────────
  recovery_provider_type_prompt: 'Typ bootstrapowego providera:',
  recovery_path_prompt: 'Ścieżka bazowa providera (nie podfolder vaulta):',
  recovery_vault_name_prompt: 'Nazwa vaulta (podfolder na providerach):',
  recovery_connecting: 'Łączenie z providerem…',
  recovery_scanning: 'Skanowanie providerów…',
  recovery_rebuilt: '\n  Odbudowano .bfs/ — %s wersja/wersji\n',
  recovery_col_version: 'Wersja',
  recovery_col_status: 'Status',
  recovery_col_consensus: 'Konsensus',
  recovery_success:
    'Użyj `bfs pull`, aby przywrócić pliki (domyślnie: najnowsza wersja).',
  recovery_failed: 'Odbudowa nieudana',

  // ─── scheme ───────────────────────────────────────────────────────────────
  scheme_data_shards_invalid: 'Shardy danych muszą być liczbą całkowitą >= 2.',
  scheme_parity_shards_invalid:
    'Shardy parzystości muszą być liczbą całkowitą >= 1.',
  scheme_requires:
    'Schemat %s/%s wymaga %s providerów, aktualnie skonfigurowanych: %s.',
  scheme_add_providers:
    'Dodaj %s provider(ów) przez `provider add`, a następnie zmień schemat.',
  scheme_remove_providers:
    'Usuń %s provider(ów) przez `provider remove`, a następnie zmień schemat.',
  scheme_changed: 'Schemat zmieniony: %s → %s/%s.',
  scheme_apply_push: 'Uruchom `bfs push`, aby zastosować nowy schemat.',

  // ─── provider add ─────────────────────────────────────────────────────────
  provider_add_current: '\nAktualne providery (%s):',
  provider_add_warn:
    'Dodanie providera zmienia schemat N+K. Uruchom `bfs push` po dodaniu, aby zaktualizować sharding.',
  provider_add_id_required: '--id jest wymagane w trybie CI',
  provider_add_path_required: '--path jest wymagane dla type=local w trybie CI',
  provider_add_name_prompt: 'Nazwa nowego providera:',
  provider_add_name_required: 'Nazwa jest wymagana',
  provider_add_exists: 'Provider "%s" już istnieje',
  provider_add_type_prompt: 'Typ providera:',
  provider_add_dir_prompt: 'Ścieżka do katalogu:',
  provider_add_success:
    'Provider "%s" dodany. Schemat: %s/%s. Uruchom `bfs push`, aby zastosować nowy schemat.',

  // ─── provider list ────────────────────────────────────────────────────────
  provider_list_empty: 'Brak skonfigurowanych providerów.',
  provider_list_header: '\nProvidrzy dla vaulta "%s" (schemat %s/%s):\n',
  provider_list_col_num: '#',
  provider_list_col_id: 'ID',
  provider_list_col_type: 'Typ',
  provider_list_col_config: 'Konfiguracja',

  // ─── provider remove ──────────────────────────────────────────────────────
  provider_remove_no_providers: 'Brak providerów w konfiguracji.',
  provider_remove_prompt: 'Który provider usunąć?',
  provider_remove_not_found:
    'Provider "%s" nie istnieje. Użyj `provider list`, aby zobaczyć dostępne nazwy lub indeksy.',
  provider_remove_impact: 'Provider "%s" jest używany w %s wersji/wersjach:',
  provider_remove_impact_warn:
    'Po usunięciu: zdrowe wersje staną się degradowane, degradowane mogą stać się uszkodzone.',
  provider_remove_strategy_prompt: 'Wybierz strategię:',
  provider_remove_strategy_relocate:
    '[R]elocate — shard istnieje, provider zmienił adres (nowe IP/host/ścieżka)',
  provider_remove_strategy_rebuild:
    '[R]ebuild — shard utracony, odbuduj z RS i prześlij na inny provider',
  provider_remove_strategy_remove:
    '[R]emove — usuń provider bez zastępstwa, zaktualizuj schemat N/K',
  provider_remove_strategy_cancel: '[A]nuluj',
  provider_remove_new_path_required:
    '--new-path jest wymagane dla strategii relocate w trybie CI',
  provider_remove_new_path_prompt: 'Nowa ścieżka do katalogu providera:',
  provider_remove_enc_password_relocate:
    'Hasło szyfrowania (do aktualizacji mapy lokalizacji):',
  provider_remove_enc_password_rebuild:
    'Hasło szyfrowania (do odczytu/zapisu mapy lokalizacji):',
  provider_remove_rebuild_scope_prompt: 'Które wersje odbudować?',
  provider_remove_rebuild_all: '[W]szystkie wersje używające tego providera',
  provider_remove_rebuild_latest: '[T]ylko najnowszą wersję',
  provider_remove_no_other_providers:
    'Brak innych dostępnych providerów do odbudowy.',
  provider_remove_target_prompt: 'Na który provider przesłać odbudowany shard?',
  provider_remove_yes_required:
    '--yes jest wymagane dla strategii remove w trybie CI',
  provider_remove_confirm:
    'Usunąć provider "%s" bez odbudowy? Wersje zostaną zdegradowane.',
  provider_remove_scope_invalid:
    'Nieprawidłowy --scope: "%s". Dozwolone: all|latest',
  provider_remove_target_required:
    '--target jest wymagane dla strategii rebuild w trybie CI',
  provider_remove_target_invalid:
    'Provider "%s" nie istnieje lub jest tym samym co usuwany',
  provider_remove_success: 'Provider "%s" usunięty.',
  provider_remove_next_steps: 'Zalecane kolejne kroki:',
  provider_remove_next_step_1: '  1. `bfs pull` — pobierz bieżącą wersję',
  provider_remove_next_step_2: '  2. `bfs push` — utwórz nową zdrową kopię',
  provider_remove_next_step_3:
    '  3. `bfs prune` — opcjonalnie usuń stare zdegradowane wersje',
  provider_relocate_success: 'Provider "%s" przeniesiony.',
  provider_rebuild_success:
    'Provider "%s" zastąpiony. Uruchom `bfs push`, aby zaktualizować schemat.',
};
