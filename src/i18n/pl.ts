import type { Strings } from './index.js';

export const pl: Strings = {
  // ─── REPL ────────────────────────────────────────────────────────────────
  repl_banner_title: '\n  BFS — System kopii zapasowych\n',
  repl_no_config: '  Brak konfiguracji. Użyj `init`, aby zacząć.',
  repl_banner_hint: '\n  Wpisz `help`, aby zobaczyć dostępne polecenia.\n',
  repl_help_header: '\n  Dostępne polecenia:\n',
  repl_help_cmd_init: 'Utwórz nową kopię zapasową',
  repl_help_cmd_push: 'Utwórz kopię zapasową bieżącego katalogu',
  repl_help_cmd_pull: 'Przywróć pliki z kopii zapasowej',
  repl_help_cmd_status: 'Pokaż status kopii zapasowej',
  repl_help_cmd_versions: 'Wylistuj wersje kopii zapasowych',
  repl_help_cmd_prune: 'Usuń stare wersje (np. 1-5, --keep-last 3)',
  repl_help_cmd_verify: 'Sprawdź dostępność i stan shardów',
  repl_help_cmd_recovery: 'Odbudowa po awarii',
  repl_help_cmd_provider_add: 'Dodaj provider',
  repl_help_cmd_provider_list: 'Wylistuj providery',
  repl_help_cmd_provider_remove: 'Usuń provider',
  repl_help_cmd_scheme_set:
    'Zmień schemat Reed-Solomon (N danych + K parzystości)',
  repl_help_cmd_clear: 'Usuń zbuforowane dane po przerwanym push/pull',
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
  cmd_cwd_desc: 'Katalog roboczy kopii zapasowej (nadpisuje bieżący katalog)',
  cmd_lang_desc: 'Ustaw język UI na stałe (np. en, pl)',
  cmd_init_desc: 'Skonfiguruj nową kopię zapasową w bieżącym katalogu',
  cmd_push_desc:
    'Utwórz kopię zapasową bieżącego katalogu (nowa wersja lub nadpisanie)',
  cmd_pull_desc: 'Przywróć pliki z kopii zapasowej',
  cmd_status_desc: 'Pokaż status kopii zapasowej',
  cmd_versions_desc: 'Wylistuj wszystkie wersje kopii zapasowych',
  cmd_prune_desc: 'Usuń stare wersje kopii zapasowych z providerów',
  cmd_verify_desc: 'Sprawdź dostępność i stan shardów dla wszystkich wersji',
  cmd_recovery_desc: 'Odbuduj .bfs/ z providerów (odtwarzanie po awarii)',
  cmd_scheme_desc: 'Zarządzaj schematem Reed-Solomon',
  cmd_scheme_set_desc:
    'Zmień schemat N/K (liczba providerów musi być równa data+parity)',
  cmd_provider_desc: 'Zarządzaj providerami',
  cmd_provider_add_desc: 'Dodaj nowy nośnik do konfiguracji kopii zapasowej',
  cmd_provider_list_desc: 'Wylistuj skonfigurowane providery',
  cmd_provider_remove_desc: 'Usuń lub zastąp provider (z opcją naprawy)',

  // ─── Global / shared ─────────────────────────────────────────────────────
  global_settings_group: 'Ustawienia BFS (globalne)',
  lang_set: 'Język ustawiony na: %s',
  no_config:
    'Brak kopii zapasowej w tym katalogu. Uruchom najpierw `bfs init`.',
  cancel: 'Anuluj',
  cancelled: 'Anulowano.',
  required: 'Wymagane',
  path_required: 'Ścieżka jest wymagana',
  path_not_dir: 'Ścieżka nie jest katalogiem',
  dir_not_exist: 'Katalog nie istnieje: %s',

  // ─── init ─────────────────────────────────────────────────────────────────
  init_header: '\n  BFS — konfiguracja kopii zapasowej\n',
  init_provider_header: '\nProvider %s:',
  init_provider_name_prompt: 'Nazwa providera (np. dysk-usb, nas-lokalny):',
  init_provider_name_required: 'Nazwa jest wymagana',
  init_provider_type_prompt: 'Typ providera:',
  init_dir_path_prompt: 'Ścieżka do katalogu:',
  init_opt_ci: 'Tryb nieinteraktywny (CI/skrypty): pomija prompty',
  init_opt_enc:
    'Włącz szyfrowanie AES-256-GCM (tylko z --ci, domyślnie wyłączone)',
  init_opt_no_compress: 'Wyłącz kompresję ZIP (domyślnie włączona)',
  init_opt_compress: 'Włącz kompresję ZIP (nadpisuje auto-detekcję)',
  init_opt_data_shards: 'Liczba shardów danych N (tryb CI)',
  init_opt_parity_shards: 'Liczba shardów parzystości K (tryb CI)',
  init_opt_provider:
    'Provider w formacie typ:id:ścieżka, np. local:usb1:/mnt/usb (wielokrotny)',
  init_opt_push_mode: 'Tryb push: new_version|overwrite|ask (tryb CI)',
  init_vault_name_arg: 'Nazwa kopii zapasowej (podfolder na nośnikach)',
  init_vault_name_prompt: 'Nazwa kopii zapasowej (= podfolder na nośnikach):',
  init_vault_name_required: 'Nazwa jest wymagana',
  init_scanning: 'Skanowanie katalogu…',
  init_found_files: 'Znaleziono %s plik(ów) (%s)',
  init_enc_prompt: 'Włączyć szyfrowanie AES-256-GCM?',
  init_compress_prompt: 'Włączyć kompresję ZIP?',
  init_compress_scanning: 'Analiza kompresji…',
  init_compress_skip_suggest:
    'Wykryto %s% danych w formatach skompresowanych (%s). Kompresja nie zmniejszy rozmiaru kopii.',
  init_compress_auto_on: 'Wykryto dane nadające się do kompresji',
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
  init_max_ram_prompt:
    'Limit RAM do kodowania (MB, wykryto: %sMB, 4096MB wystarczy):',
  init_opt_max_ram: 'Limit RAM do kodowania w MB (tryb CI)',
  init_success:
    'Kopia zapasowa "%s" gotowa. Użyj `bfs push`, aby wykonać pierwszą kopię.',

  // ─── clear ────────────────────────────────────────────────────────────────
  cmd_clear_desc:
    'Wyczyść tymczasowe dane kopii zapasowej z przerwanego push/pull',
  clear_done: 'Cache wyczyszczony.',

  // ─── config ───────────────────────────────────────────────────────────────
  cmd_config_desc: 'Wyświetl lub zmień ustawienia kopii zapasowej',
  config_current_settings: 'Aktualne ustawienia:',
  config_updated: 'Ustawienia zaktualizowane.',
  config_reset: 'Ustawienie przywrócone do domyślnego.',
  config_reset_no_field: 'Podaj --cache-dir lub --temp-dir razem z --reset.',
  config_dir_hint:
    'Zmień przez `bfs config --%s <ścieżka>` lub `bfs config --%s --reset`',
  config_opt_cache_dir: 'Ustaw katalog cache (zastępuje .bfs/cache)',
  config_opt_temp_dir:
    'Ustaw katalog plików tymczasowych (zastępuje systemowy temp)',
  config_opt_max_ram: 'Ustaw limit RAM do kodowania (MB, 0 = auto)',
  config_opt_reset: 'Przywróć ustawienie do wartości domyślnej',
  config_opt_on: 'Włącz funkcję (compress, encryption)',
  config_opt_off: 'Wyłącz funkcję (compress, encryption)',
  config_feature_on: '%s włączono.',
  config_feature_off: '%s wyłączono.',
  config_feature_unknown:
    'Nieznana funkcja: %s. Dostępne: compress, encryption',
  config_next_push: 'Zmiana wejdzie w życie przy następnym push.',
  config_label_compression: 'kompresja:',
  config_label_encryption: 'szyfrowanie:',

  // ─── push ─────────────────────────────────────────────────────────────────
  push_preparing: 'Przygotowanie push…',
  push_completed: 'Push zakończony',
  push_success: 'Kopia zapasowa przesłana na wszystkie providery.',
  push_failed: 'Push nieudany',
  push_skipped_header:
    '%s plik(ów) nie można było odczytać i zostało pominięte:',
  push_cache_hint:
    'Dane kopii zapisane w cache. Użyj `bfs push --cache` aby wysłać bez ponownego pakowania.',
  push_opt_new: 'Wymuś nową wersję',
  push_opt_overwrite: 'Nadpisz bieżącą wersję',
  push_opt_password: 'Hasło szyfrowania (pomija interaktywny prompt)',
  push_opt_cache:
    'Wyślij zbuforowane dane kopii z poprzedniej przerwanej operacji',
  push_opt_max_ram: 'Nadpisz limit RAM dla tego push (MB)',
  push_opt_no_compress: 'Wyłącz kompresję ZIP dla tego push',
  push_opt_compress: 'Włącz kompresję ZIP dla tego push',
  push_compress_conflict:
    'Nie można używać --compress i --no-compress jednocześnie',
  vault_compressing: 'Kompresowanie…',
  vault_decompressing: 'Dekompresowanie…',
  opt_temp_dir_desc: 'Katalog dla plików tymczasowych podczas push/pull',
  opt_cache_dir_desc:
    'Katalog dla zbuforowanych danych kopii (zastępuje .bfs/cache)',

  // ─── pull ─────────────────────────────────────────────────────────────────
  pull_preparing: 'Przygotowanie pull…',
  pull_completed: 'Pull zakończony',
  pull_success: 'Pliki przywrócone.',
  pull_failed: 'Pull nieudany',
  pull_skipped_header: '%s plik(ów) nie można było zapisać na dysku:',
  pull_cache_hint:
    'Dane kopii zapisane w cache. Napraw uprawnienia i użyj `bfs pull --cache` aby ponowić.',
  pull_opt_version: 'Numer wersji do przywrócenia (domyślnie: najnowsza)',
  pull_opt_force: 'Nadpisz katalog bez potwierdzenia',
  pull_opt_yes:
    'Automatycznie potwierdź nadpisanie (zachowuje pliki, w przeciwieństwie do --force)',
  pull_opt_password: 'Hasło deszyfrowania (pomija interaktywny prompt)',
  pull_opt_provider: 'Typ nośnika (np. local, ssh, ftp)',
  pull_opt_path: 'Ścieżka bazowa nośnika; dla zdalnych: user@host/ścieżka',
  pull_opt_name: 'Nazwa kopii zapasowej (podfolder na nośniku)',
  pull_opt_cache:
    'Ponów przy użyciu zbuforowanych danych kopii z poprzedniej przerwanej operacji',

  // ─── status ───────────────────────────────────────────────────────────────
  status_header: '\n  Status kopii zapasowej\n',
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
  prune_opt_keep_last: 'Zachowaj N najnowszych wersji, usuń pozostałe',
  prune_opt_yes: 'Pomiń prompt potwierdzenia',
  prune_range_invalid: 'Nieprawidłowy zakres: %s',
  prune_version_format_invalid: 'Nieprawidłowy format wersji: "%s"',
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
  recovery_opt_provider: 'Typ bootstrapowego nośnika (np. local, ssh, ftp)',
  recovery_opt_path: 'Ścieżka bazowa nośnika; dla zdalnych: user@host/ścieżka',
  recovery_path_prompt:
    'Ścieżka bazowa nośnika (nie podfolder kopii zapasowej):',
  recovery_vault_name_prompt: 'Nazwa kopii zapasowej (podfolder na nośnikach):',
  recovery_opt_name: 'Nazwa kopii zapasowej (podfolder na nośnikach)',
  recovery_opt_password: 'Hasło (dla zaszyfrowanej kopii zapasowej)',
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

  // ─── provider: local-fs ──────────────────────────────────────────────────
  provider_local_path_not_exist_confirm:
    'Ścieżka "%s" nie istnieje. Utworzyć ją?',
  provider_local_path_not_exist_error:
    'Ścieżka "%s" nie istnieje, a utworzenie zostało odrzucone.',
  provider_local_path_not_writable: 'Ścieżka "%s" nie jest zapisywalna.',

  // ─── provider add ─────────────────────────────────────────────────────────
  provider_add_opt_ci: 'Tryb nieinteraktywny (CI/skrypty): pomija prompty',
  provider_add_opt_id: 'ID nowego nośnika (tryb CI)',
  provider_add_opt_type: 'Typ nośnika: local (tryb CI)',
  provider_add_opt_path:
    'Ścieżka do katalogu nośnika (tryb CI, dla type=local)',
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
  provider_list_header: '\nNośniki dla kopii "%s" (schemat %s/%s):\n',
  provider_list_col_num: '#',
  provider_list_col_id: 'ID',
  provider_list_col_type: 'Typ',
  provider_list_col_config: 'Konfiguracja',

  // ─── provider remove ──────────────────────────────────────────────────────
  provider_remove_opt_password:
    'Hasło szyfrowania (dla strategii rebuild/relocate)',
  provider_remove_opt_strategy:
    'Strategia CI: relocate|rebuild|remove (pomija prompt)',
  provider_remove_opt_new_path:
    'Nowa ścieżka nośnika dla strategii relocate; opcjonalnie z prefiksem typu: local:/ścieżka (tryb CI)',
  provider_remove_opt_new_type:
    'Nowy typ nośnika dla strategii relocate (gdy obecny typ jest nieznany)',
  provider_remove_opt_target: 'Docelowy nośnik dla strategii rebuild (tryb CI)',
  provider_remove_opt_scope: 'Zakres odbudowy: all|latest (domyślnie: all)',
  provider_remove_opt_yes: 'Pomiń potwierdzenie dla strategii remove (tryb CI)',
  provider_remove_strategy_invalid:
    'Nieprawidłowa strategia: "%s". Dozwolone: relocate|rebuild|remove|cancel',
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
  provider_remove_rebuild_new_location:
    '[N]owa lokalizacja — dodaj nowy nośnik do odbudowanej kopii',
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

  // ─── vault operations ────────────────────────────────────────────────────
  vault_download_shards: 'Pobieranie shardów dla wersji %s…',
  vault_provider_not_found:
    'Provider "%s" nie znaleziony w konfiguracji — pomijam shard %s',
  vault_download_shard_progress: 'Pobieranie sharda %s/%s',
  vault_provider_unreachable: 'Nośnik "%s" jest niedostępny — pomijam.',
  vault_file_missing_on_provider:
    'Dane kopii brakują na nośniku "%s" — pomijam.',
  vault_decoding_rs: 'Dekodowanie Reed-Solomon…',
  vault_ask_decrypt_password: 'Podaj hasło deszyfrowania:',
  vault_decrypting: 'Odszyfrowanie…',
  vault_push_version_confirm:
    'Na dysku: wersja %s. Najnowsza: %s. Push utworzy wersję %s. Kontynuować?',
  vault_using_cached_blob: 'Używam zbuforowanych danych…',
  vault_no_cached_blob_push:
    'Brak zbuforowanych danych — wykonuję pełne pakowanie…',
  vault_push_skipped_confirm:
    '%s plik(ów) nie można było odczytać:\n%s\nKontynuować bez nich?',
  vault_ask_encrypt_password: 'Podaj hasło szyfrowania:',
  vault_ask_confirm_password: 'Potwierdź hasło:',
  vault_encrypting: 'Szyfrowanie shardów…',
  vault_password_overrides_config:
    'Szyfrowanie włączone przez --password (w konfiguracji szyfrowanie wyłączone).',
  vault_encoding_rs: 'Kodowanie Reed-Solomon…',
  vault_uploading_shards: 'Przesyłanie shardów…',
  vault_upload_shard_progress: 'Przesyłanie sharda %s/%s',
  vault_no_cached_blob_pull:
    'Brak zbuforowanych danych — wykonuję pełne pobieranie…',
  vault_pull_overwrite_confirm:
    'Na dysku: wersja %s. Przywrócenie wersji %s nadpisze katalog. Kontynuować?',
  vault_unpacking_files: 'Rozpakowywanie plików…',
  vault_pull_write_error_confirm:
    '%s plik(ów) nie można było zapisać:\n%s\nNapraw uprawnienia, naciśnij Y aby ponowić lub N aby anulować.',
  vault_degraded_provider_unreachable:
    'Pula zdegradowana: jeden lub więcej nośników jest niedostępnych. Użyj `bfs provider remove`, aby zastąpić nośnik, a następnie `bfs push`, aby przywrócić redundancję.',
  vault_degraded_file_missing:
    'Pula zdegradowana: dane kopii zostały usunięte ze sprawnego nośnika. Uruchom `bfs push`, aby odtworzyć kopię.',

  // ─── recovery operations (vault layer) ──────────────────────────────────
  recovery_ask_version_password:
    'Podaj hasło dla tej wersji (zostaw puste, aby pominąć):',

  // ─── bootstrap operations ────────────────────────────────────────────────
  bootstrap_single_provider_warn:
    'Tylko 1 provider dostępny — nie można zweryfikować konsensusu. Dane mogą być naruszone. Kontynuuję.',
};
