import { BfsError } from '../core/errors.js';
import { dbg, debugEnabled, stdinState } from '../debug.js';
import { fmt, getLang } from '../i18n/index.js';
import type { AdapterRegistrationMeta, Nullable, ProviderConfig, ProviderHelp, ProviderIO, StorageProvider } from '../types/index.js';
import { BFS_PROVIDER_API_VERSION } from '../version.js';

// --- Provider ID validation ---------------------------------------------------

/**
 * Charset allowed for provider ids. `id` is a technical key: it names the
 * subfolder on each provider ({base_path}/{vault_name} is owned by the vault,
 * but the provider type filename prefix and RemoteRef.provider_id use the
 * id verbatim), keys the entry in `.bfs/config.json`, appears in logs, and
 * gets split out of shell-style CLI tokens by the first `:`. Whitespace,
 * colons, slashes, quotes and similar break at least one of those uses.
 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validates a provider id against the shared charset rule.
 * @throws BfsError when the id is empty or contains disallowed characters
 */
export function validateProviderId(id: string): void {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new BfsError(fmt('provider_id_invalid_chars', id));
  }
}

/**
 * Validates a vault name before it becomes a directory segment on every medium
 * ({base}/{vaultName}/shard_...). Reuses the provider-id charset (letters,
 * digits, ".", "_", "-") and additionally rejects a leading dot and any ".."
 * so the name cannot escape or hide under the base path. The runtime providers
 * keep their own assertSafeVaultName floor; this is the friendly early gate at
 * init time.
 * @throws BfsError when the name is empty, has disallowed characters, starts
 *   with ".", or contains "..".
 */
export function validateVaultName(name: string): void {
  if (!PROVIDER_ID_PATTERN.test(name) || name.startsWith('.') || name.includes('..')) {
    throw new BfsError(fmt('vault_name_invalid_chars', name));
  }
}

// --- Provider Factory ---------------------------------------------------------

/**
 * Factory describing how to create a provider of a given type.
 * Exported as part of the public adapter contract - third-party plugin
 * authors (bfs-provider-* npm packages) declare one and register it via
 * {@link providerRegistry}.
 */
export interface ProviderFactory {
  /**
   * Active UI language tag (BCP-47, e.g. 'en', 'pl'). BFS keeps this in
   * sync with the user's `--lang` setting via
   * {@link ProviderRegistry.setLang}. Adapters MAY read `this.lang` from
   * inside {@link help} to localize their description / flags / examples.
   * Adapters that don't support i18n can ignore the field - BFS still
   * sets it, but the adapter is free to return an English-only payload.
   */
  lang: string;

  /**
   * Provider's own name (technical / brand label like "OneDrive",
   * "FTP/FTPS"). Shown in `bfs provider -h` headings and in interactive
   * "select provider type" prompts. NOT translated - proper nouns and
   * protocol names stay identical across UI languages.
   */
  readonly displayName: string;

  /**
   * Minimum BFS_PROVIDER_API_VERSION required by this factory. Registry
   * refuses the registration when BFS_PROVIDER_API_VERSION < required.
   * Omitted -> assumed 1 (for adapters published before this contract existed).
   */
  readonly requiresApiVersion?: number;

  /**
   * Construct a provider instance from persisted config + ProviderIO.
   * @throws BfsError on unrecoverable construction failure
   */
  create(config: ProviderConfig, io: ProviderIO): StorageProvider;

  /**
   * Structured help describing the provider for `bfs provider -h`. BFS
   * prepends `Usage: bfs provider add --name <name> --type <type>` before
   * {@link ProviderHelp.usage} and renders flags / examples uniformly.
   * Required - even providers with no extra flags return an object with
   * empty `flags` / `examples`. Implementations may read `this.lang` to
   * localize the returned payload.
   */
  help(): ProviderHelp;
}

// --- Provider Registry --------------------------------------------------------

/**
 * One registry slot: the factory for a provider type plus the adapter package
 * metadata it registered with (null for built-ins).
 */
interface RegistryEntry {
  readonly factory: ProviderFactory;
  readonly meta: Nullable<AdapterRegistrationMeta>;
}

/** Methods introduced in provider API v2 that every adapter instance must implement. */
const PROVIDER_API_V2_METHODS = ['usesSidecar', 'uploadHeaderSidecar', 'downloadHeaderSidecar', 'verifyShard'] as const;

/**
 * Verifies a freshly created provider instance implements the current provider
 * API surface. The registration-time gate only rejects adapters declaring a
 * HIGHER requiresApiVersion; an adapter built against an older API (or with none
 * declared) clears that gate yet may lack methods added since. Compilation
 * protects TypeScript adapters, but a published JavaScript adapter run without
 * recompilation would otherwise fail with a raw "x is not a function" deep in a
 * verify/heal call. This surfaces the gap at instantiation as a typed, localized error.
 *
 * @param type     - Provider type string (for the error message)
 * @param provider - Instance returned by the factory
 * @throws BfsError when any method required by the current API is missing
 */
function assertProviderApiComplete(type: string, provider: StorageProvider): void {
  const surface = provider as unknown as Record<string, unknown>;
  for (const method of PROVIDER_API_V2_METHODS) {
    if (typeof surface[method] !== 'function') {
      throw new BfsError(fmt('provider_adapter_incompatible', type, method, String(BFS_PROVIDER_API_VERSION)));
    }
  }
}

/**
 * Registry of provider factories keyed by type string.
 * Instantiate directly for isolated test scenarios; for production use the
 * default {@link providerRegistry} singleton.
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /**
   * Registers a factory for the given type identifier.
   * @param type    - Provider type string (e.g. "local", "ftp", "ssh")
   * @param factory - Factory descriptor (displayName, create, help, optional
   *                  requiresApiVersion)
   * @param meta    - Adapter package metadata. External adapters MUST pass
   *                  { packageName, packageVersion } from their own
   *                  package.json so BFS can record it in ProviderConfig
   *                  .adapterPackage for disaster recovery. Built-in
   *                  providers omit it.
   * @throws BfsError when factory.requiresApiVersion > BFS_PROVIDER_API_VERSION
   */
  register(type: string, factory: ProviderFactory, meta?: AdapterRegistrationMeta): void {
    const required = factory.requiresApiVersion ?? 1;
    if (required > BFS_PROVIDER_API_VERSION) {
      throw new BfsError(`Provider adapter "${type}" requires BFS provider API >= ${required}, this BFS installation only supports up to ${BFS_PROVIDER_API_VERSION}. Upgrade BFS or use an older adapter version.`);
    }
    this.entries.set(type, { factory, meta: meta ?? null });
  }

  /**
   * Creates a StorageProvider instance from config using the registered factory.
   * @throws BfsError when no factory is registered for config.type, or the
   *         instance is missing a method required by the current provider API
   */
  create(config: ProviderConfig, io: ProviderIO): StorageProvider {
    const entry = this.entries.get(config.type);
    if (!entry) {
      throw new BfsError(`Unknown provider type: "${config.type}". Registered types: ${[...this.entries.keys()].join(', ')}`);
    }
    const provider = entry.factory.create(config, io);
    assertProviderApiComplete(config.type, provider);
    return provider;
  }

  /**
   * Lists registered provider types with their display names.
   */
  listTypes(): ReadonlyArray<{ type: string; displayName: string }> {
    return [...this.entries.entries()].map(([type, e]) => ({ type, displayName: e.factory.displayName }));
  }

  /**
   * Returns the factory for a given type, or undefined when unknown.
   */
  getFactory(type: string): ProviderFactory | undefined {
    return this.entries.get(type)?.factory;
  }

  /**
   * Returns adapter metadata for a given type, or null when the type is
   * built-in or unknown.
   */
  getMeta(type: string): Nullable<AdapterRegistrationMeta> {
    return this.entries.get(type)?.meta ?? null;
  }

  /**
   * True when `type` is known to the registry.
   */
  has(type: string): boolean {
    return this.entries.has(type);
  }

  /**
   * Propagates the active UI language to every registered factory. Adapters
   * read the value from `factory.lang` inside their `help()` implementation.
   */
  setLang(lang: string): void {
    for (const entry of this.entries.values()) {
      entry.factory.lang = lang;
    }
  }
}

/** Default provider registry singleton. */
export const providerRegistry = new ProviderRegistry();

// --- CLI ProviderIO ------------------------------------------------------------

/**
 * Creates a ProviderIO implementation backed by Inquirer.js prompts and chalk output.
 * Use this in the CLI/REPL context.
 *
 * @param workDir - BFS working directory (absolute) - exposed to providers
 *                  as `io.workDir` so they can resolve relative paths their
 *                  own flags or prompts accept.
 * @param interactive - Whether prompts can reach a user. Defaults to whether
 *                  stdin is a TTY, so a piped/`</dev/null` run is treated as
 *                  non-interactive automatically. Commands that declare a
 *                  non-interactive run (`bfs --ci`, or a command's own `--ci`
 *                  such as `repair --ci`) pass `false` so the decision holds
 *                  even on a TTY; a flag that merely supplies data
 *                  (`--bootstrap`, `--strategy`) does not.
 *
 *                  When it resolves to `false`, no prompt is issued at all:
 *                  `ask`/`askSecret`/`choose` throw and `confirm` answers "no".
 *                  A prompt with nobody to answer it never settles - the event
 *                  loop empties, the process ends where it stands with exit code
 *                  0, and the rejection arrives during shutdown, too late for
 *                  any caller to act on. This is what makes the contract's "a
 *                  provider MUST NOT block on a prompt when this is false"
 *                  enforceable rather than advisory.
 * @returns       A ProviderIO that reads from stdin, writes `info` to stdout and
 *                `warn` / `debug` to stderr
 */
export function createCliProviderIO(workDir: string, interactive?: boolean): ProviderIO {
  const isInteractive = interactive ?? process.stdin.isTTY === true;
  return {
    lang: getLang(),
    workDir,
    interactive: isInteractive,

    async ask(prompt: string): Promise<string> {
      if (!isInteractive) throw new BfsError(fmt('prompt_no_operator', prompt));
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:ask:before', { prompt, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([{ type: 'input', name: 'value', message: prompt }]);
        dbg('inquirer:ask:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:ask:error', { name: (e as Error).name, msg: (e as Error).message, ...stdinState() });
        throw e;
      }
    },

    async askSecret(prompt: string): Promise<string> {
      if (!isInteractive) throw new BfsError(fmt('prompt_no_operator', prompt));
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:askSecret:before', { prompt, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([{ type: 'password', name: 'value', message: prompt, mask: '*' }]);
        dbg('inquirer:askSecret:after', { answered: true, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:askSecret:error', { name: (e as Error).name, msg: (e as Error).message, ...stdinState() });
        throw e;
      }
    },

    async confirm(message: string): Promise<boolean> {
      // A yes/no question has a safe answer when nobody is there to give one:
      // "no" leaves the caller's guard standing, whatever that guard protects.
      // Asking anyway would never settle - the event loop empties and the
      // process dies where it stands.
      //
      // It is a floor, not a verdict. A caller that can name what the missing
      // answer would have settled owes the operator that instead of a refusal
      // attributed to them, and checks `interactive === false` before asking -
      // the recovered-locations gate and the push/pull overwrite gates do.
      if (!isInteractive) {
        dbg('inquirer:confirm:declined-no-operator', { message });
        return false;
      }
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:confirm:before', { message, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: boolean }>([{ type: 'confirm', name: 'value', message, default: false }]);
        dbg('inquirer:confirm:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:confirm:error', { name: (e as Error).name, msg: (e as Error).message, ...stdinState() });
        throw e;
      }
    },

    async choose(message: string, options: string[]): Promise<string> {
      // Unlike a yes/no question, a menu has no safe answer to invent: which
      // entry means "give up" is the caller's knowledge, not this layer's.
      if (!isInteractive) throw new BfsError(fmt('prompt_no_operator', message));
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:choose:before', { message, options, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([{ type: 'rawlist', name: 'value', message, choices: options }]);
        dbg('inquirer:choose:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:choose:error', { name: (e as Error).name, msg: (e as Error).message, ...stdinState() });
        throw e;
      }
    },

    info(message: string): void {
      // Dynamic import not needed - chalk is a regular ESM dependency
      // eslint-disable-next-line no-console
      console.log(message);
    },

    debug(message: string): void {
      // Live-binding from src/debug.ts - `enableDebug()` flips it during
      // process startup when --debug is detected on argv.
      if (!debugEnabled) return;
      // eslint-disable-next-line no-console
      console.error(message);
    },

    warn(message: string): void {
      // eslint-disable-next-line no-console
      console.warn(message);
    },

    progress(_label: string, _percent: number): void {
      // Progress rendering is handled by the CLI layer (ora spinner).
      // Providers receive this hook but the implementation is left to the caller.
    },
  };
}

// --- Mock ProviderIO -----------------------------------------------------------

/**
 * Creates a ProviderIO backed by pre-defined answers for use in tests.
 * `ask` and `askSecret` return answers[prompt] or "" if not found.
 * `confirm` returns true when answers[message] === "true", false otherwise.
 * `choose` returns answers[message] or the first option if not found.
 * `info`, `debug` and `warn` are no-ops (captured in the returned `logs`
 * array, tagged with their level).
 *
 * @param answers - Map of prompt/message text -> answer string
 * @param workDir - Optional working directory exposed as `io.workDir`.
 *                  Defaults to `process.cwd()` so existing tests that don't
 *                  exercise path resolution keep working unchanged.
 * @param interactive - Optional `io.interactive` value. Defaults to `true`
 *                  (prompts answered from `answers`); pass `false` to exercise
 *                  the non-interactive path where a provider must not prompt.
 * @returns       A ProviderIO and a `logs` array collecting info/debug/warn
 *                output
 */
export function createMockProviderIO(answers: Record<string, string> = {}, workDir: string = process.cwd(), interactive = true): { io: ProviderIO; logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }> } {
  const logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }> = [];

  const io: ProviderIO = {
    lang: 'en',
    workDir,
    interactive,

    async ask(prompt: string): Promise<string> {
      return answers[prompt] ?? '';
    },

    async askSecret(prompt: string): Promise<string> {
      return answers[prompt] ?? '';
    },

    async confirm(message: string): Promise<boolean> {
      return answers[message] === 'true';
    },

    async choose(message: string, options: string[]): Promise<string> {
      return answers[message] ?? options[0] ?? '';
    },

    info(message: string): void {
      logs.push({ level: 'info', message });
    },

    debug(message: string): void {
      logs.push({ level: 'debug', message });
    },

    warn(message: string): void {
      logs.push({ level: 'warn', message });
    },

    progress(_label: string, _percent: number): void {
      // no-op in tests
    },
  };

  return { io, logs };
}
