import chalk from 'chalk';
import type { Ora } from 'ora';
import type { ProviderIO } from '../types/index.js';

/**
 * Runs an interactive action with the spinner paused, restarting it only if it
 * was running before. A throw from `action` skips the restart — the caller's
 * error path owns the spinner from there (e.g. `spinner.fail()`).
 *
 * @param spinner - ora spinner to pause for the action's duration
 * @param action - the delegated interactive call to await
 * @returns whatever `action` resolves to
 */
async function _pausedAround<T>(spinner: Ora, action: () => Promise<T>): Promise<T> {
  const wasSpinning = spinner.isSpinning;
  if (wasSpinning) spinner.stop();
  const result = await action();
  if (wasSpinning) spinner.start();
  return result;
}

/**
 * Wraps a ProviderIO so adapter output drives an ora spinner: `info`/`progress`
 * update the spinner line in place, while `warn` and the interactive prompts
 * pause the spinner for their duration so their output does not interleave with
 * the animated spinner line. The spinner is only restarted if it was running
 * before — a prompt or warn fired while the spinner was idle leaves it idle.
 *
 * @param io - underlying ProviderIO the wrapper delegates to
 * @param spinner - ora spinner the wrapper drives
 * @returns a ProviderIO mirroring `io` but routing output through `spinner`
 */
export function createSpinnerIo(io: ProviderIO, spinner: Ora): ProviderIO {
  return {
    ...io,
    info(msg: string): void {
      spinner.text = chalk.dim(msg);
    },
    progress(label: string, percent: number): void {
      spinner.text = `${label} ${chalk.dim(`${Math.round(percent)}%`)}`;
    },
    warn(msg: string): void {
      const wasSpinning = spinner.isSpinning;
      if (wasSpinning) spinner.stop();
      io.warn(msg);
      if (wasSpinning) spinner.start();
    },
    ask: (message: string): Promise<string> => _pausedAround(spinner, () => io.ask(message)),
    askSecret: (message: string): Promise<string> => _pausedAround(spinner, () => io.askSecret(message)),
    confirm: (message: string): Promise<boolean> => _pausedAround(spinner, () => io.confirm(message)),
    choose: (message: string, options: string[]): Promise<string> => _pausedAround(spinner, () => io.choose(message, options)),
  };
}
