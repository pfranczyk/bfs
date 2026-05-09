# BFS provider adapter guide

This guide is for developers publishing external storage-provider adapters
for BFS (e.g. `bfs-adapter-ssh`, `bfs-adapter-s3`). BFS core is blind to
concrete provider types — everything a new storage backend needs is
declared via the `StorageProvider` / `ProviderFactory` contract.

## Install

Add BFS as a runtime dependency:

```bash
npm install bfs-vault
```

Import the contract from the dedicated entry point:

```ts
import {
  type StorageProvider,
  type ProviderFactory,
  type ProviderIO,
  type ProviderConfig,
  type ProviderHelp,
  type CliProviderInput,
  type AdapterRegistrationMeta,
  type RemoteRef,
  providerRegistry,
  BFS_PROVIDER_API_VERSION,
  ProviderError,
} from 'bfs-vault/provider';
```

Everything re-exported from `bfs-vault/provider` is covered by
`BFS_PROVIDER_API_VERSION`. Breaking changes bump that integer.

## Implement StorageProvider

Every adapter class implements the full `StorageProvider` interface.
The interface splits into two groups of methods:

- **Runtime I/O** — `authenticate`, `setVaultName`, `upload`, `download`,
  `delete`, `rename`, `updateShardHeader`, `list`, `listVaults`, `healthCheck`.
- **Configuration lifecycle** — `configureInteractive`, `configureFromFlags`,
  `validateConfig`, `describeConfig`, `getSecretFields`, `probeConnection`.

The configuration-lifecycle methods let the CLI stay blind to provider
type. The CLI calls them polymorphically from `bfs init`, `bfs provider
add`, and `bfs recovery`; the provider owns the flow end-to-end.

Skeleton (trimmed for brevity):

```ts
import type {
  StorageProvider,
  ProviderConfig,
  ProviderIO,
  CliProviderInput,
  RemoteRef,
} from 'bfs-vault/provider';
import { ProviderError } from 'bfs-vault/provider';

export class MyProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'my-backend';
  private readonly io: ProviderIO;

  constructor(config: ProviderConfig, io: ProviderIO) {
    // Lazy init — BFS may construct a placeholder instance with config:{}
    // to call configureInteractive, so don't throw on empty fields here.
    this.id = config.id;
    this.io = io;
    // …read config.config into fields with safe defaults…
  }

  // ─── Runtime I/O ─────────────────────────────────────────────────────
  async authenticate(): Promise<void> { /* … */ }
  setVaultName(name: string): void { /* … */ }
  async upload(filename, data, size): Promise<RemoteRef> { /* … */ }
  async download(ref): Promise<Readable> { /* … */ }
  async delete(ref): Promise<void> { /* … */ }
  async rename(ref, newFilename): Promise<RemoteRef> { /* … */ }
  async updateShardHeader(ref, headerData): Promise<RemoteRef> { /* … */ }
  async list(prefix?): Promise<RemoteRef[]> { /* … */ }
  async listVaults(): Promise<string[]> { /* … */ }
  async healthCheck(): Promise<boolean> { /* … */ }

  // ─── Configuration lifecycle ─────────────────────────────────────────

  async configureInteractive(io: ProviderIO): Promise<Record<string, unknown>> {
    // Use io.ask / io.askSecret / io.confirm to collect fields.
    // Return a plain object persisted as ProviderConfig.config.
  }

  async configureFromFlags(
    input: CliProviderInput,
  ): Promise<Record<string, unknown>> {
    // Non-interactive CI mode — see "CI configuration" below.
  }

  validateConfig(config: Record<string, unknown>): string[] {
    // Purely structural checks — do not touch the network or fs here.
    // Return [] when valid; non-empty human-readable messages otherwise.
  }

  describeConfig(config: Record<string, unknown>): string {
    // One-line summary for `bfs provider list`. MUST mask secret fields.
  }

  getSecretFields(): readonly string[] {
    return ['password']; // or whatever keys in your config are secret
  }

  async probeConnection(): Promise<void> {
    // Full write / read / compare / cleanup against the real remote.
    // Called by CLI BEFORE persisting config — a throw here keeps the
    // user's vault config untouched.
    // Wrap each step's failure in a ProviderError with step context.
  }
}
```

### Upload integrity — verify writes you can't trust

Whenever the transport behind `upload()` is not byte-exact — FTP with its
historical ASCII-mode quirks, cloud APIs that retry on flaky connections,
SFTP over unreliable links, anything that sits on the network — **re-read
the file immediately after writing and compare it hash-for-hash before
returning a `RemoteRef`**. BFS's shard format carries its own trailing
SHA-256, so silent mid-stream corruption will eventually surface as
`Shard checksum mismatch` during `bfs pull`, but only after the backup
has been "confirmed" written and perhaps kept for months.

The built-in FTP adapter does this:

```ts
async upload(
  shardFilename: string,
  data: Readable,
  _size: number,
): Promise<RemoteRef> {
  const buffer = await streamToBuffer(data);
  const hash = hashBuffer(buffer);
  const remotePath = `${this.vaultPath()}/${shardFilename}`;

  await this.withClient(async (client) => {
    await client.ensureDir(this.vaultPath());
    await client.uploadFrom(Readable.from(buffer), remotePath);

    // Round-trip verify: any byte loss / byte flip / size mismatch
    // throws BEFORE this upload() resolves. The caller treats a throw
    // as a failed write and won't persist the manifest for this shard.
    const roundTripped = await this.downloadToBuffer(client, remotePath);
    if (roundTripped.length !== buffer.length) {
      throw new ProviderError(
        `Upload size mismatch for ${shardFilename}: ` +
          `sent ${buffer.length} B, stored ${roundTripped.length} B`,
      );
    }
    if (hashBuffer(roundTripped) !== hash) {
      throw new ProviderError(
        `Upload hash mismatch for ${shardFilename} — data corrupted in transit`,
      );
    }
  });

  return { provider_id: this.id, path: shardFilename, hash };
}
```

Skip verification only when the transport itself provides an integrity
guarantee you trust (e.g. the backend's response includes a strong
content hash you've already checked against). When in doubt, verify —
the cost is one extra read per shard during push, and the benefit is
catching corruption at write time instead of during disaster recovery.

### Locale

BFS exposes the active UI language to adapters in two complementary
places, depending on context:

- **`ProviderIO.lang`** — used during runtime methods that have access
  to a `ProviderIO` instance: `configureInteractive`, `authenticate`,
  `upload`, `download`, etc. Read it to localize your own prompts and
  messages routed through `io.ask` / `io.info` / `io.warn`.
- **`factory.lang`** — used inside `ProviderFactory.help()`, which has
  no `ProviderIO`. BFS keeps the field in sync with the user's `--lang`
  setting via `providerRegistry.setLang()` before any help is rendered.

Both fields hold a BCP-47 tag (`'en'`, `'pl'`, …). They are
informational — adapters that don't care about i18n simply return
English-only strings everywhere. BFS does not prescribe a translation
API; pick whatever you like (`i18next`, plain object dictionaries, JSON
files, …).

### Working directory (`io.workDir`)

`ProviderIO.workDir` is an absolute path — the same working directory
BFS itself uses, respecting the global `bfs --cwd <dir>` flag. Use it
whenever your adapter accepts a relative path via its own flags or
prompts so that the user's working context is honored:

```ts
const raw = findStringFlag(input.rawArgs, '--config-file');
const absolute = path.isAbsolute(raw)
  ? raw
  : path.resolve(this.io.workDir, raw);
```

Reaching for `process.cwd()` instead will produce the wrong path when
BFS was launched from a different directory via `--cwd`.

## CI configuration (`CliProviderInput`)

`bfs provider add --ci` and `bfs init --ci --provider "type:name …"`
recognize exactly three BFS-level flags:

- `--ci`
- `--name <name>` — user-chosen identifier for this provider entry (for
  the `init` grammar this is the part after `type:` in the spec token)
- `--type <type>` — provider type string (matches what you pass to
  `providerRegistry.register`; for `init` it is the part before `:`)

**Every other CLI token is forwarded verbatim** to your adapter through
`CliProviderInput.rawArgs`. BFS never interprets them — `--config-file`,
`--bucket`, `--private-key`, anything you define is your adapter's
grammar, not BFS's. BFS calls your adapter like this:

```ts
await myProvider.configureFromFlags({
  name: 'cloud',
  rawArgs: [                     // everything BFS didn't bind, in order
    '--private-key', '/home/alice/.ssh/id_rsa',
    '--passphrase-env', 'SECRET',
  ],
});
```

You choose how to interpret the input — read a file, fetch a URL, parse
flags, derive from `name` alone. Typical patterns:

1. **Config-file flag** — parse `rawArgs` for your `--config-file <path>`
   (or `--config`, `--config-url`, whatever you document), resolve it
   against `io.workDir`, read the file, validate. The built-in FTP and
   LocalFS adapters use this pattern.
2. **Raw-args only** — parse `rawArgs` with your own mini-parser or a
   library like `minimist`. Example for SSH: `--host`, `--user`,
   `--private-key`.
3. **Either / both** — e.g. a baseline config file whose entries can be
   overridden by individual flags. Up to the adapter to document.

### Convenience helpers

BFS ships `src/providers/flags.ts` with two helpers adapters can opt into
(they are not part of the contract — adapters may ignore them):

- `findStringFlag(rawArgs, '--config-file') → string | null`
- `readJsonObjectFile(absolutePath, adapterLabel) → Record<string, unknown>`
  — reads + parses + validates that the result is a plain object; throws
  `ProviderError` with the label prefix on any failure.

### Secrets recommendation

Reference secrets, don't embed them. Take a path to a private-key file
or an env-var name (`--passphrase-env`) rather than shipping the secret
itself as a flag value — `ps`, `.bash_history` and
`ConsoleHost_history.txt` retain command lines.

## Provider help (`ProviderHelp`)

`ProviderFactory.help()` is **required** and returns a structured help
object. BFS renders each registered provider uniformly under
`bfs provider -h` in an "Available providers:" section. BFS prepends
`Usage: bfs provider add --name <name> --type <type>` automatically —
fill the suffix in `usage`.

The adapter MAY read `this.lang` to localize its `description` and flag
descriptions. BFS keeps `factory.lang` in sync with the user's `--lang`
setting via `providerRegistry.setLang()`, so by the time `help()` is
called the field already holds the active language tag (`'en'`, `'pl'`,
…). Adapters that don't support i18n simply ignore `this.lang` and
return English-only strings.

`displayName` is the provider's own name (proper noun / brand /
protocol — `OneDrive`, `FTP/FTPS`, `My Storage Backend`) and is **NOT
translated** — proper nouns stay identical across UI languages.
`examples` are CLI commands (typically copy-pasteable verbatim) and
also stay in their canonical English form.

```ts
const factory: ProviderFactory = {
  lang: 'en',
  displayName: 'SSH/SFTP',
  // …

  help(): ProviderHelp {
    // Adapter-local i18n. The shape of `dict` is up to you — separate
    // JSON files, inlined object, fetched from a translation service,
    // anything. BFS only requires that `help()` returns a ProviderHelp.
    const dict = this.lang === 'pl' ? plStrings : enStrings;

    return {
      usage: '--host <h> --user <u> --private-key <path> [--port 22]',
      description: dict.description,
      flags: [
        { flag: '--host <host>',          description: dict.flag_host },
        { flag: '--port <port>',          description: dict.flag_port },
        { flag: '--user <user>',          description: dict.flag_user },
        { flag: '--private-key <path>',   description: dict.flag_pk },
        { flag: '--passphrase-env <var>', description: dict.flag_env },
      ],
      examples: [
        'bfs provider add --ci --name cloud --type ssh \\',
        '  --host backup.example.com --user bfs --private-key ~/.ssh/bfs_ed25519',
      ],
      // Optional. When omitted, BFS falls back to
      // `npm install -g ${packageName}` derived from registration meta.
      // Use this field only when you need a custom hint (extra setup steps,
      // alternative install channel, etc.).
      installation: 'npm i -g bfs-adapter-ssh',
    };
  },
};
```

For adapters that only support English, just return literal strings —
the contract requires the `lang` field to exist on the factory but does
not require the adapter to act on it:

```ts
help(): ProviderHelp {
  return {
    usage: '--bucket <name>',
    description: 'Stores shards as objects in S3.',
    flags: [{ flag: '--bucket <name>', description: 'S3 bucket name' }],
    examples: [],
  };
}
```

Leave `flags` and `examples` empty (`[]`) when the adapter takes no
configuration beyond the defaults. Leave `usage` as an empty string if
`--name`/`--type` alone are enough.

## Register the factory

External adapters **must** register with `AdapterRegistrationMeta` so BFS
can persist the full npm spec (`<name>@<version>`) in every provider
entry. This is what lets disaster-recovery on a fresh machine tell the
user exactly which `npm install -g` commands reconstruct the environment.

```ts
import pkg from '../package.json' with { type: 'json' };
import { providerRegistry, type ProviderFactory } from 'bfs-vault/provider';
import { MyProvider } from './provider.js';

const factory: ProviderFactory = {
  lang: 'en',                              // BFS overwrites via providerRegistry.setLang()
  displayName: 'My Storage Backend',       // proper noun / brand — NOT translated
  requiresApiVersion: 1,                   // minimum BFS provider API version
  create: (config, io) => new MyProvider(config, io),
  help() { /* see "Provider help" section */ },
};

providerRegistry.register('my-backend', factory, {
  packageName: pkg.name,
  packageVersion: pkg.version,
});
```

Call `providerRegistry.register()` at module load time. The adapter
package's main entry should perform the registration, so users activate
the adapter simply by importing it (or BFS auto-loads it — see "Loading"
below).

**Built-in vs external:** `adapterPackage` on the persisted
`ProviderConfig` is `null` for built-in providers (local, ftp) and
`"<packageName>@<packageVersion>"` for adapters that passed
`AdapterRegistrationMeta`. The flag determines whether disaster recovery
prints a `npm install -g …` hint or a "BFS installation broken" error
when the type is missing from the registry.

## Disaster recovery and adapter versioning

When BFS pushes a backup, it stores the adapter npm spec (e.g.
`bfs-adapter-ssh@1.0.1`) inside each shard's location map. A fresh BFS
install running `bfs recovery` on that backup reads the shard header,
discovers which adapters are needed, and produces a report:

```
The following adapters are required but not installed:

  ssh          — install: npm install -g bfs-adapter-ssh@1.0.1
  acme-cloud   — install: npm install -g @acme/bfs-adapter-cloud@2.3.0

Install them and retry. Alternatively, if enough shards are available
via already-installed providers, pass --allow-missing-adapters to try
Reed-Solomon recovery from what is present.
```

**Version mismatch** (installed version differs from recorded):

- Patch/minor difference → soft warning, recovery continues.
- Major difference → strong warning with a suggested pin command;
  user decides whether to pin the exact version or proceed.

**Recommendation for adapter authors:** keep the shape of
`ProviderConfig.config` backwards compatible within a major semver
bump. Breaking the config format is fine for a `2.0.0 → 3.0.0` release
but avoid it in patch/minor — legacy shards otherwise fail when decoded
by the newer adapter.

## Version compatibility

Adapters declare the minimum contract version they need:

```ts
const factory: ProviderFactory = {
  lang: 'en',
  displayName: 'Foo',
  requiresApiVersion: 1,
  create: (config, io) => new FooProvider(config, io),
  help() { /* … */ },
};
```

`ProviderRegistry.register()` throws `BfsError` when
`requiresApiVersion > BFS_PROVIDER_API_VERSION`. This prevents an adapter
built against a newer BFS from silently mis-calling methods that don't
exist in the installed version.

Check the installed version at runtime if you need to branch on it:

```ts
import { BFS_PROVIDER_API_VERSION, BFS_VERSION } from 'bfs-vault/provider';

console.log(`Running on BFS ${BFS_VERSION}, contract v${BFS_PROVIDER_API_VERSION}`);
```

### Semver policy for the contract

- **Patch bump of BFS** — no contract change. Your adapter keeps working.
- **Minor bump of BFS** — new *optional* methods may be added to the
  contract. `BFS_PROVIDER_API_VERSION` is incremented; older adapters
  keep registering successfully (their `requiresApiVersion` is still
  satisfied). BFS only calls the new methods when the provider
  implements them.
- **Major bump of BFS** — breaking change. Old adapters fail the
  `requiresApiVersion` check at registration with a clear error message
  pointing at the version mismatch.

## Package conventions

- **Name**: publish as `bfs-adapter-<type>` (e.g. `bfs-adapter-ssh`).
  Scoped packages are allowed: `@corp/bfs-adapter-<type>`. A future BFS
  release will auto-load packages with this prefix from the global
  `node_modules`; today, users activate adapters by importing them.
- **Peer deps**: declare `"bfs-vault": "^<version>"` as a peer dependency.
- **Contract version**: set `requiresApiVersion` on your factory to the
  current `BFS_PROVIDER_API_VERSION` that your adapter targets. Read
  `BFS_PROVIDER_API_VERSION` from `bfs-vault/provider` to check at
  build time — this way your adapter stays honest about what it needs
  regardless of which BFS minor release you publish against.
- **Registration meta**: always pass `{ packageName, packageVersion }` to
  `providerRegistry.register`. Without it, BFS treats the adapter as
  built-in, and disaster-recovery cannot suggest the right
  `npm install` command.

## Loading

Today, users activate an adapter by importing it before their BFS
operations. BFS plans auto-discovery of `node_modules/bfs-adapter-*` in
a future phase; the contract above is stable regardless.
