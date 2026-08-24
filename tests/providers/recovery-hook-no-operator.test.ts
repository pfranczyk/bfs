import { describe, expect, it } from 'vitest';
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { SshProvider } from '../../src/providers/ssh.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';

// The recovery hook shows the operator which host a secret is about to reach and
// lets them refuse. With nobody at the keyboard the confirmation answers itself
// with "no" and the adapter reports that recovery was declined - a decision no
// one made. Bootstrap then turns the throw into a degraded skip
// (connectViaRecoveryHook in src/vault/bootstrap.ts, a documented outcome that
// stays), so the storage drops out of the recovery and the only account of why
// is that untrue sentence.
//
// The way through exists and is a command, not just a flag: an operator who has
// checked the recovered locations re-runs `bfs recovery --trust-locations`,
// which pre-approves the hosts.
//
// WHERE that sentence goes is load-bearing, so only warn() counts here. The
// throw is swallowed by the caller. `debug()` is silenced without `bfs --debug`.
// And `info()` is worse than either during a recovery: registerRecovery hands
// adapters a createSpinnerIo wrapper (src/cli/spinner-io.ts) whose info() only
// assigns spinner.text - overwritten on a terminal, never emitted at all down a
// pipe. warn() is the one channel that stops the spinner and prints.
//
// The pair with a real operator is deliberate: someone who has just refused this
// host must not be handed the command that pre-approves it.

const NON_INTERACTIVE = false;

function ftpConfig(): ProviderConfig {
  return { id: 'ftp-1', type: 'ftp', adapterPackage: null, config: { host: 'ftphost', port: 21, user: 'u', password: 'p', path: '/backup', secure: false } };
}

function sshConfig(): ProviderConfig {
  return { id: 'ssh-1', type: 'ssh', adapterPackage: null, config: { host: 'sshhost', port: 22, user: 'u', password: 'p', path: '/backup', auth_method: 'password' } };
}

/** The only channel that reaches the operator through the recovery spinner. */
function warned(logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>): string {
  return logs
    .filter((l) => l.level === 'warn')
    .map((l) => l.message)
    .join('\n');
}

/** Runs the hook and hands back whatever it threw, without failing the test. */
async function refusalFrom(provider: { connectForRecovery?: (io: ProviderIO, pool: never[]) => Promise<unknown> }, io: ProviderIO): Promise<string> {
  const hook = provider.connectForRecovery;
  if (!hook) throw new Error('the adapter under test must implement connectForRecovery');
  return hook.call(provider, io, []).then(
    () => '',
    (e: unknown) => String(e),
  );
}

/**
 * An IO from before the field existed - `interactive` absent, not false. A guard
 * written as `!io.interactive` would read it as "nobody is there" and take the
 * host confirmation away from an operator who is.
 */
function ioWithoutTheField(): { io: ProviderIO; logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }> } {
  const { io, logs } = createMockProviderIO({}, process.cwd(), true);
  const legacy: ProviderIO = { ...io, confirm: async (): Promise<boolean> => true };
  Reflect.deleteProperty(legacy, 'interactive');
  return { io: legacy, logs };
}

describe('connectForRecovery with nobody to confirm the target', () => {
  it('should tell the FTP operator how to pre-approve the host instead of reporting a refusal', async () => {
    const { io, logs } = createMockProviderIO({}, process.cwd(), NON_INTERACTIVE);

    const refusal = await refusalFrom(new FtpProvider(ftpConfig(), io), io);

    expect(refusal).not.toBe('');
    expect(refusal).not.toMatch(/declined/i);
    expect(warned(logs)).toMatch(/bfs recovery[\s\S]*--trust-locations/);
    expect(warned(logs)).toMatch(/ftphost/);
  });

  it('should tell the SSH operator how to pre-approve the host instead of reporting a refusal', async () => {
    const { io, logs } = createMockProviderIO({}, process.cwd(), NON_INTERACTIVE);

    const refusal = await refusalFrom(new SshProvider(sshConfig(), io), io);

    expect(refusal).not.toBe('');
    expect(refusal).not.toMatch(/declined/i);
    expect(warned(logs)).toMatch(/bfs recovery[\s\S]*--trust-locations/);
    expect(warned(logs)).toMatch(/sshhost/);
  });

  it('should not offer --trust-locations to an operator who refused the FTP host', async () => {
    const { io, logs } = createMockProviderIO({}, process.cwd(), true);

    const refusal = await refusalFrom(new FtpProvider(ftpConfig(), io), io);

    expect(refusal).not.toBe('');
    expect(`${refusal}\n${warned(logs)}`).not.toMatch(/--trust-locations/);
  });

  it('should not offer --trust-locations to an operator who refused the SSH host', async () => {
    const { io, logs } = createMockProviderIO({}, process.cwd(), true);

    const refusal = await refusalFrom(new SshProvider(sshConfig(), io), io);

    expect(refusal).not.toBe('');
    expect(`${refusal}\n${warned(logs)}`).not.toMatch(/--trust-locations/);
  });

  it('should still put the host to an IO that never declared the field', async () => {
    const { io, logs } = ioWithoutTheField();

    await refusalFrom(new FtpProvider(ftpConfig(), io), io);

    expect(warned(logs)).not.toMatch(/--trust-locations/);
  });
});
