import { dbg, stdinState } from '../debug.js';
import type {
  ProviderConfig,
  ProviderIO,
  StorageProvider,
} from '../types/index.js';

// ─── Provider Registry ────────────────────────────────────────────────────────

type ProviderFactory = (
  config: ProviderConfig,
  io: ProviderIO,
) => StorageProvider;

const registry = new Map<string, ProviderFactory>();

/**
 * Registers a provider factory for a given type identifier.
 * Called once at startup for each built-in provider (e.g. "local").
 *
 * @param type    - Provider type string (e.g. "local", "ftp", "ssh")
 * @param factory - Factory function that creates a provider instance
 */
export function registerProvider(type: string, factory: ProviderFactory): void {
  registry.set(type, factory);
}

/**
 * Creates a StorageProvider instance for the given config using the registered factory.
 *
 * @param config - Provider configuration from VaultConfig.providers[]
 * @param io     - ProviderIO for user interaction (CLI or mock)
 * @returns      A new StorageProvider instance
 * @throws Error if no factory is registered for config.type
 */
export function createProvider(
  config: ProviderConfig,
  io: ProviderIO,
): StorageProvider {
  const factory = registry.get(config.type);
  if (!factory) {
    throw new Error(
      `Unknown provider type: "${config.type}". Registered types: ${[...registry.keys()].join(', ')}`,
    );
  }
  return factory(config, io);
}

// ─── CLI ProviderIO ────────────────────────────────────────────────────────────

/**
 * Creates a ProviderIO implementation backed by Inquirer.js prompts and chalk output.
 * Use this in the CLI/REPL context.
 *
 * @returns A ProviderIO that reads from stdin and writes to stdout
 */
export function createCliProviderIO(): ProviderIO {
  return {
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
 * `info` and `warn` are no-ops (captured in the returned `logs` array).
 *
 * @param answers - Map of prompt/message text → answer string
 * @returns       A ProviderIO and a `logs` array collecting info/warn output
 */
export function createMockProviderIO(answers: Record<string, string> = {}): {
  io: ProviderIO;
  logs: Array<{ level: 'info' | 'warn'; message: string }>;
} {
  const logs: Array<{ level: 'info' | 'warn'; message: string }> = [];

  const io: ProviderIO = {
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

    warn(message: string): void {
      logs.push({ level: 'warn', message });
    },

    progress(_label: string, _percent: number): void {
      // no-op in tests
    },
  };

  return { io, logs };
}
