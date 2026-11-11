import type { ProviderIO } from '../types/index.js';

/**
 * Per-command memory of the operator's answers about a server identity.
 *
 * A stored "trust a new key" opt-in without a pin is not consent, so with an
 * operator present the adapter asks. The answer - a refusal too - must last the
 * whole command and no longer: one command builds a fresh provider instance per
 * part and may connect several times per instance (the collision guard and the
 * upload on push, one connection per part and version on verify), so a field on
 * the instance would ask again and again, while a process-wide memory would carry
 * a consent from one REPL command into the next. The command is identified by
 * its ProviderIO, which the CLI creates once per command.
 *
 * Answers are keyed by the target AND the fingerprint the operator was shown: a
 * consent for host A does not cover host B, and a consent for one key does not
 * cover a different key presented later at the same target.
 *
 * A command may wrap its io (the recovery spinner io is a spread copy with the
 * prompts re-routed); `linkConsentScope` makes the wrapper share the memory of
 * the io it wraps. `Symbol.for` keeps the link readable across two copies of this
 * module (a bundled and an unbundled one).
 */
const CONSENT_SCOPE = Symbol.for('bfs.identityConsentScope');

const answers = new WeakMap<object, Map<string, boolean>>();

/** Returns the object that identifies the command `io` belongs to. */
function scopeOf(io: ProviderIO): object {
  const linked = (io as unknown as Record<symbol, unknown>)[CONSENT_SCOPE];
  return typeof linked === 'object' && linked !== null ? linked : io;
}

/** Builds the memory key for one target and one presented fingerprint. */
function answerKey(target: string, fingerprint: string): string {
  return `${target}\n${fingerprint}`;
}

/**
 * Makes `wrapper` share the consent memory of `base`, so an answer given through
 * either is remembered for the other within the same command.
 *
 * @param wrapper - an io derived from `base` for the same command
 * @param base    - the io the wrapper delegates to
 */
export function linkConsentScope(wrapper: ProviderIO, base: ProviderIO): void {
  Object.defineProperty(wrapper, CONSENT_SCOPE, { value: scopeOf(base), enumerable: true, configurable: true });
}

/**
 * Returns the answer the operator already gave in this command for `target`
 * presenting `fingerprint`, or null when they have not been asked yet.
 *
 * @param io          - the command's io
 * @param target      - the server the question is about (e.g. `user@host:port`)
 * @param fingerprint - the identity the server presented
 * @returns true (accepted), false (refused) or null (not asked yet)
 */
export function recallIdentityConsent(io: ProviderIO, target: string, fingerprint: string): Nullable<boolean> {
  const answer = answers.get(scopeOf(io))?.get(answerKey(target, fingerprint));
  return answer === undefined ? null : answer;
}

/**
 * Remembers the operator's answer for `target` presenting `fingerprint` until the
 * command (its io) is gone.
 *
 * @param io          - the command's io
 * @param target      - the server the question was about
 * @param fingerprint - the identity the operator was shown
 * @param accepted    - the operator's answer
 */
export function rememberIdentityConsent(io: ProviderIO, target: string, fingerprint: string, accepted: boolean): void {
  const scope = scopeOf(io);
  let byTarget = answers.get(scope);
  if (byTarget === undefined) {
    byTarget = new Map();
    answers.set(scope, byTarget);
  }
  byTarget.set(answerKey(target, fingerprint), accepted);
}
