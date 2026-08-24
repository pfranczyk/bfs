import { ConfigureRestartRequested } from '../core/errors.js';
import { tFor } from '../i18n/index.js';
import type { ProviderIO } from '../types/index.js';

/**
 * How the operator answered a server-identity question asked while their
 * connection settings were being collected.
 */
export type IdentityTrustChoice = 'accept' | 'back' | 'cancel';

/**
 * How many times one configure call may return to the connection prompts.
 * A bound is required rather than tidy: an IO that always answers "go back" -
 * a test double, or a stream that resolves the same way forever - would
 * otherwise loop without end.
 */
export const MAX_CONFIGURE_RESTARTS = 3;

/**
 * Puts a presented server identity to the operator while their settings are
 * being collected, offering a way back to the prompts alongside accepting and
 * cancelling. Refusing an identity usually means "I aimed at the wrong server",
 * and without that third exit the mistake costs every field already entered.
 *
 * Falls back to a plain yes/no on `confirmMessage` when nobody can work a menu
 * (`io.interactive === false`), so a non-interactive caller keeps both today's
 * behaviour and today's wording.
 *
 * @param io             - ProviderIO carrying the question
 * @param menuMessage    - what to show above the three exits
 * @param confirmMessage - the yes/no form used when there is no one to choose
 * @returns which exit the operator took
 */
export async function askIdentityTrust(io: ProviderIO, menuMessage: string, confirmMessage: string): Promise<IdentityTrustChoice> {
  if (io.interactive === false) {
    return (await io.confirm(confirmMessage)) ? 'accept' : 'cancel';
  }
  const accept = tFor(io.lang, 'trust_choice_accept');
  const back = tFor(io.lang, 'trust_choice_back');
  const cancel = tFor(io.lang, 'trust_choice_cancel');
  const chosen = await io.choose(menuMessage, [accept, back, cancel]);
  switch (chosen) {
    case accept:
      return 'accept';
    case back:
      return 'back';
    default:
      // cancel, or anything unexpected -> treat as a refusal (fail-closed).
      return 'cancel';
  }
}

/**
 * Signals that the operator wants the connection prompts again. Raised by an
 * identity decision and absorbed by `withConfigureRestarts`, so it never leaves
 * the adapter.
 *
 * @param reason - short description of which decision offered the way back
 */
export function requestConfigureRestart(reason: string): never {
  throw new ConfigureRestartRequested(reason);
}

/**
 * Runs `attempt`, starting it over whenever it asks to go back to the prompts,
 * up to MAX_CONFIGURE_RESTARTS times. Each restart runs `attempt` from scratch,
 * so nothing read during an abandoned pass - a certificate, a host key - can
 * survive into the settings that are finally saved.
 *
 * @param io          - ProviderIO used to tell the operator they are going back
 * @param attempt     - collects the settings once
 * @param onExhausted - builds the error to raise once the restarts run out
 * @returns whatever `attempt` returns on the pass the operator sees through
 * @throws whatever `attempt` throws, or `onExhausted()` after the last restart
 */
export async function withConfigureRestarts<T>(io: ProviderIO, attempt: () => Promise<T>, onExhausted: () => Error): Promise<T> {
  for (let restarts = 0; restarts <= MAX_CONFIGURE_RESTARTS; restarts++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ConfigureRestartRequested)) throw err;
      if (restarts === MAX_CONFIGURE_RESTARTS) break;
      io.info(tFor(io.lang, 'configure_reenter_notice'));
    }
  }
  throw onExhausted();
}
