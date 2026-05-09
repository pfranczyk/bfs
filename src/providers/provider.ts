import { BfsError } from '../core/errors.js';
import { dbg, debugEnabled, stdinState } from '../debug.js';
import { fmt, getLang } from '../i18n/index.js';
import type {
  AdapterRegistrationMeta,
  ProviderConfig,
  ProviderHelp,
  ProviderIO,
  StorageProvider,
} from '../types/index.js';
import { BFS_PROVIDER_API_VERSION } from '../version.js';

// ─── Provider ID validation ───────────────────────────────────────────────────

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

// ─── Provider Factory ─────────────────────────────────────────────────────────

/**
 * Factory describing how to create a provider of a given type.
 * Exported as part of the public adapter contract — third-party plugin
 * authors (bfs-provider-* npm packages) declare one and register it via
 * {@link providerRegistry}.
 */
export interface ProviderFactory {
  /**
   * Active UI language tag (BCP-47, e.g. 'en', 'pl'). BFS keeps this in
   * sync with the user's `--lang` setting via
   * {@link ProviderRegistry.setLang}. Adapters MAY read `this.lang` from
   * inside {@link help} to localize their description / flags / examples.
   * Adapters that don't support i18n can ignore the field — BFS still
   * sets it, but the adapter is free to return an English-only payload.
   */
  lang: string;

  /**
   * Provider's own name (technical / brand label like "OneDrive",
   * "FTP/FTPS"). Shown in `bfs provider -h` headings and in interactive
   * "select provider type" prompts. NOT translated — proper nouns and
   * protocol names stay identical across UI languages.
   */
  readonly displayName: string;

  /**
   * Minimum BFS_PROVIDER_API_VERSION required by this factory. Registry
   * refuses the registration when BFS_PROVIDER_API_VERSION < required.
   * Omitted → assumed 1 (for adapters published before this contract existed).
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
   * Required — even providers with no extra flags return an object with
   * empty `flags` / `examples`. Implementations may read `this.lang` to
   * localize the returned payload.
   */
  help(): ProviderHelp;
}

// ─── Provider Registry ────────────────────────────────────────────────────────

/**
 * Registry of provider factories keyed by type string.
 * Instantiate directly for isolated test scenarios; for production use the
 * default {@link providerRegistry} singleton.
 */
interface RegistryEntry {
  readonly factory: ProviderFactory;
  readonly meta: Nullable<AdapterRegistrationMeta>;
}

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
  register(
    type: string,
    factory: ProviderFactory,
    meta?: AdapterRegistrationMeta,
  ): void {
    const required = factory.requiresApiVersion ?? 1;
    if (required > BFS_PROVIDER_API_VERSION) {
      throw new BfsError(
        `Provider adapter "${type}" requires BFS provider API >= ${required}, ` +
          `this BFS installation only supports up to ${BFS_PROVIDER_API_VERSION}. ` +
          `Upgrade BFS or use an older adapter version.`,
      );
    }
    this.entries.set(type, { factory, meta: meta ?? null });
  }

  /**
   * Creates a StorageProvider instance from config using the registered factory.
   * @throws Error when no factory is registered for config.type
   */
  create(config: ProviderConfig, io: ProviderIO): StorageProvider {
    const entry = this.entries.get(config.type);
    if (!entry) {
      throw new Error(
        `Unknown provider type: "${config.type}". Registered types: ${[...this.entries.keys()].join(', ')}`,
      );
    }
    return entry.factory.create(config, io);
  }

  /**
   * Lists registered provider types with their display names.
   * Used by CLI to build "select provider type" prompts without hardcoded lists.
   */
  listTypes(): ReadonlyArray<{ type: string; displayName: string }> {
    return [...this.entries.entries()].map(([type, e]) => ({
      type,
      displayName: e.factory.displayName,
    }));
  }

  /**
   * Returns the factory for a given type, or undefined when unknown.
   */
  getFactory(type: string): ProviderFactory | undefined {
    return this.entries.get(type)?.factory;
  }

  /**
   * Returns adapter metadata for a given type, or null when the type is
   * built-in or unknown. Used by `bfs provider add` to populate
   * ProviderConfig.adapterPackage and by `bfs provider -h` to derive an
   * install hint when the provider did not set {@link ProviderHelp.installation}.
   */
  getMeta(type: string): Nullable<AdapterRegistrationMeta> {
    return this.entries.get(type)?.meta ?? null;
  }

  /**
   * True when `type` is known to the registry. Used by adapter-preflight
   * to detect missing plugins before a pull/recovery attempt.
   */
  has(type: string): boolean {
    return this.entries.has(type);
  }

  /**
   * Propagates the active UI language to every registered factory. Called
   * by BFS startup (right after {@link import('../i18n/index.js').setLang})
   * and by tests that exercise `bfs provider -h` rendering. Adapters read
   * the value from `factory.lang` inside their `help()` implementation.
   */
  setLang(lang: string): void {
    for (const entry of this.entries.values()) {
      entry.factory.lang = lang;
    }
  }
}

/** Default registry used by built-in providers and the CLI. */
export const providerRegistry = new ProviderRegistry();

// ─── CLI ProviderIO ────────────────────────────────────────────────────────────

/**
 * Creates a ProviderIO implementation backed by Inquirer.js prompts and chalk output.
 * Use this in the CLI/REPL context.
 *
 * @param workDir - BFS working directory (absolute) — exposed to providers
 *                  as `io.workDir` so they can resolve relative paths their
 *                  own flags or prompts accept.
 * @returns       A ProviderIO that reads from stdin and writes to stdout
 */
export function createCliProviderIO(workDir: string): ProviderIO {
  return {
    lang: getLang(),
    workDir,

    async ask(prompt: string): Promise<string> {
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:ask:before', { prompt, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([
          { type: 'input', name: 'value', message: prompt },
        ]);
        dbg('inquirer:ask:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:ask:error', {
          name: (e as Error).name,
          msg: (e as Error).message,
          ...stdinState(),
        });
        throw e;
      }
    },

    async askSecret(prompt: string): Promise<string> {
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:askSecret:before', { prompt, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([
          { type: 'password', name: 'value', message: prompt, mask: '*' },
        ]);
        dbg('inquirer:askSecret:after', { answered: true, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:askSecret:error', {
          name: (e as Error).name,
          msg: (e as Error).message,
          ...stdinState(),
        });
        throw e;
      }
    },

    async confirm(message: string): Promise<boolean> {
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:confirm:before', { message, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: boolean }>([
          { type: 'confirm', name: 'value', message, default: false },
        ]);
        dbg('inquirer:confirm:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:confirm:error', {
          name: (e as Error).name,
          msg: (e as Error).message,
          ...stdinState(),
        });
        throw e;
      }
    },

    async choose(message: string, options: string[]): Promise<string> {
      const { default: inquirer } = await import('inquirer');
      dbg('inquirer:choose:before', { message, options, ...stdinState() });
      try {
        const { value } = await inquirer.prompt<{ value: string }>([
          { type: 'rawlist', name: 'value', message, choices: options },
        ]);
        dbg('inquirer:choose:after', { value, ...stdinState() });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        return value;
      } catch (e) {
        dbg('inquirer:choose:error', {
          name: (e as Error).name,
          msg: (e as Error).message,
          ...stdinState(),
        });
        throw e;
      }
    },

    info(message: string): void {
      // Dynamic import not needed — chalk is a regular ESM dependency
      // eslint-disable-next-line no-console
      console.log(message);
    },

    debug(message: string): void {
      // Live-binding from src/debug.ts — `enableDebug()` flips it during
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

// ─── Mock ProviderIO ───────────────────────────────────────────────────────────

/**
 * Creates a ProviderIO backed by pre-defined answers for use in tests.
 * `ask` and `askSecret` return answers[prompt] or "" if not found.
 * `confirm` returns true when answers[message] === "true", false otherwise.
 * `choose` returns answers[message] or the first option if not found.
 * `info`, `debug` and `warn` are no-ops (captured in the returned `logs`
 * array, tagged with their level).
 *
 * @param answers - Map of prompt/message text → answer string
 * @param workDir - Optional working directory exposed as `io.workDir`.
 *                  Defaults to `process.cwd()` so existing tests that don't
 *                  exercise path resolution keep working unchanged.
 * @returns       A ProviderIO and a `logs` array collecting info/debug/warn
 *                output
 */
export function createMockProviderIO(
  answers: Record<string, string> = {},
  workDir: string = process.cwd(),
): {
  io: ProviderIO;
  logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;
} {
  const logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }> = [];

  const io: ProviderIO = {
    lang: 'en',
    workDir,

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
