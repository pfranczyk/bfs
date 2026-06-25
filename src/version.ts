/**
 * Current BFS release version. Must stay in sync with package.json — update
 * both together for a release. Used for diagnostic display ("BFS x.y.z").
 */
export const BFS_VERSION = '0.8.0-rc.1';

/**
 * Provider contract API version.
 *
 * Integer, bumped ONLY when the set of methods / signatures on
 * StorageProvider, ProviderFactory, or ProviderIO changes in a way that
 * would break an already-compiled third-party adapter.
 *
 * Bump policy: one bump per public release. All unreleased contract changes
 * collapse into the same version number until a release cuts a new tag.
 * This integer has nothing in common with BFS_VERSION semver — it only
 * tracks the public adapter contract.
 *
 * Adapter authors declare the minimum version they need via
 * ProviderFactory.requiresApiVersion. ProviderRegistry.register() refuses
 * to register a factory that requires a newer API than this BFS ships.
 *
 * History:
 *   1 — first publicly exported adapter contract. BFS v0.4.0 and earlier
 *       did not expose an adapter API; version 1 is the initial release of
 *       the contract as shipped in the next public BFS version:
 *         • StorageProvider runtime I/O — authenticate, setVaultName, upload,
 *           download, delete, rename, updateShardHeader, list, getSize,
 *           downloadHeader, listVaults, healthCheck. `getSize(ref)` returns
 *           the byte size via a lightweight metadata call (FTP SIZE,
 *           fs.stat, S3 HEAD). `downloadHeader(ref, maxBytes)` returns the
 *           first `maxBytes` bytes; implementations MUST avoid pulling more
 *           than `maxBytes` over the wire (FTP aborts after the limit;
 *           LocalFS uses a bounded createReadStream).
 *         • Configuration lifecycle on StorageProvider —
 *           configureInteractive, configureFromFlags, validateConfig,
 *           describeConfig, getSecretFields, probeConnection.
 *         • configureFromFlags receives CliProviderInput ({ name, rawArgs })
 *           and returns Promise<Record<string, unknown>>. BFS never
 *           interprets adapter flags — rawArgs carries every CLI token the
 *           user typed after --ci/--name/--type, verbatim and in order. The
 *           adapter parses whatever grammar it documents, including any
 *           --config-file / --bucket / --private-key conventions it chooses.
 *         • ProviderFactory is an object interface with `lang` (mutable
 *           string, BFS keeps in sync via ProviderRegistry.setLang()),
 *           `displayName` (readonly string, technical/brand name — NOT
 *           translated), `create`, optional `requiresApiVersion`, and a
 *           required `help()` returning structured ProviderHelp. Adapters
 *           may read `this.lang` from inside `help()` to localize their
 *           description / flags / examples; built-in adapters use BFS's
 *           own i18n via `tFor(this.lang, key)`.
 *         • ProviderIO primitives — ask, askSecret, confirm, choose, info,
 *           debug, warn, progress — plus readonly lang: string (informational)
 *           and readonly workDir: string (BFS working directory, respects
 *           `bfs --cwd`; adapters use it to resolve relative paths their
 *           own flags or prompts may accept). `debug(message)` is silenced
 *           unless the user runs `bfs --debug`; built-in providers route
 *           connection chatter and retry diagnostics through it so
 *           verify/push/pull stay quiet by default.
 *         • ProviderRegistry.register() accepts optional
 *           AdapterRegistrationMeta ({ packageName, packageVersion });
 *           external adapters MUST pass it so BFS can persist
 *           ProviderConfig.adapterPackage for disaster-recovery
 *           reproducibility.
 *         • ProviderConfig carries adapterPackage: Nullable<string>,
 *           persisted in .bfs/config.json, manifest and shard header JSON
 *           location map. Backward compatible when reading shards produced
 *           by pre-contract BFS — the field defaults to null, which is the
 *           correct semantics for built-in providers.
 *         • `bfs provider add` and `bfs init --ci --provider` are strictly
 *           pass-through: BFS recognizes only --ci, --name, --type (plus
 *           `type:name` in the init spec) and forwards every other token
 *           to the provider via rawArgs.
 *   2 — header storage strategy + shard verification on StorageProvider.
 *       Adds four methods every adapter must implement; an adapter compiled
 *       against version 1 no longer satisfies the interface, hence the bump:
 *         • usesSidecar(): boolean — reports whether the adapter keeps an
 *           updated header in a sidecar file (true) or rewrites it in place
 *           inside the shard (false; built-in local/ftp).
 *         • uploadHeaderSidecar(ref, sidecarBytes) / downloadHeaderSidecar(ref,
 *           maxBytes) — sidecar I/O in the standard BFSH binary format. Called
 *           only when usesSidecar() === true; MUST throw otherwise. On the
 *           read-path a present sidecar wins over the in-shard header.
 *         • verifyShard(ref, expected: ShardIdentity) — returns a
 *           VerifyShardResult classifying the shard identity check
 *           (ok / not_found / mismatch / auth_failed / corrupted /
 *           unverifiable) without requiring the vault key.
 *         • connectForRecovery(io, pool, options?) — OPTIONAL, added without a
 *           bump: lets an adapter show the destination host and collect/reuse
 *           the transport secret during `bfs recovery`, so a forged --no-enc
 *           location map cannot phish the secret before the operator sees the
 *           target. Adapters that omit it fall back to the legacy
 *           required_inputs prompt flow (and stay exposed).
 */
export const BFS_PROVIDER_API_VERSION = 2;
