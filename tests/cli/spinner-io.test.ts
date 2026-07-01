import type { Ora } from 'ora';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpinnerIo } from '../../src/cli/spinner-io.js';
import { createCliProviderIO, createMockProviderIO } from '../../src/providers/provider.js';

interface FakeSpinner {
  text: string;
  isSpinning: boolean;
  start(): FakeSpinner;
  stop(): FakeSpinner;
}

/**
 * Minimal ora double. Records each start/stop together with the number of
 * delegated io log entries observed at that moment, so a test can prove that a
 * delegated call (io.warn / io.ask) fired strictly between a stop and the
 * following start — i.e. the spinner was paused for the call's duration.
 *
 * Returns both the `Ora`-typed handle (passed to createSpinnerIo) and the
 * mutable `fake` (Ora's `isSpinning` is readonly, so the test drives state here).
 */
function makeFakeSpinner(logs: { length: number }): { spinner: Ora; fake: FakeSpinner; events: Array<{ kind: 'start' | 'stop'; logsLen: number }> } {
  const events: Array<{ kind: 'start' | 'stop'; logsLen: number }> = [];
  const fake: FakeSpinner = {
    text: '',
    isSpinning: false,
    start(): FakeSpinner {
      fake.isSpinning = true;
      events.push({ kind: 'start', logsLen: logs.length });
      return fake;
    },
    stop(): FakeSpinner {
      fake.isSpinning = false;
      events.push({ kind: 'stop', logsLen: logs.length });
      return fake;
    },
  };
  return { spinner: fake as unknown as Ora, fake, events };
}

describe('createSpinnerIo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── warn ───────────────────────────────────────────────────────────────

  it('should pause and resume the spinner around warn when spinning', () => {
    const { io, logs } = createMockProviderIO();
    const { spinner, fake, events } = makeFakeSpinner(logs);
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = true;

    wrapped.warn('disk almost full');

    expect(events.map((e) => e.kind)).toEqual(['stop', 'start']);
    // stop fires before io.warn is delegated (logsLen 0), start after it (logsLen 1):
    // proves the warn was emitted while the spinner was stopped.
    expect(events[0]).toEqual({ kind: 'stop', logsLen: 0 });
    expect(events[1]).toEqual({ kind: 'start', logsLen: 1 });
    expect(logs).toEqual([{ level: 'warn', message: 'disk almost full' }]);
    expect(fake.isSpinning).toBe(true);
  });

  it('should not touch the spinner on warn when it was not spinning', () => {
    const { io, logs } = createMockProviderIO();
    const { spinner, fake, events } = makeFakeSpinner(logs);
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = false;

    wrapped.warn('heads up');

    expect(events).toEqual([]);
    expect(logs).toEqual([{ level: 'warn', message: 'heads up' }]);
    expect(fake.isSpinning).toBe(false);
  });

  // ─── prompts ──────────────────────────────────────────────────────────────

  it('should pause and resume the spinner around ask and return the answer', async () => {
    const { io } = createMockProviderIO({ 'Vault name?': 'picture' });
    const { spinner, fake, events } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = true;

    const answer = await wrapped.ask('Vault name?');

    expect(answer).toBe('picture');
    expect(events.map((e) => e.kind)).toEqual(['stop', 'start']);
    expect(fake.isSpinning).toBe(true);
  });

  it('should pause and resume the spinner around askSecret and return the secret', async () => {
    const { io } = createMockProviderIO({ 'Password?': 'hunter2' });
    const { spinner, fake, events } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = true;

    const secret = await wrapped.askSecret('Password?');

    expect(secret).toBe('hunter2');
    expect(events.map((e) => e.kind)).toEqual(['stop', 'start']);
  });

  it('should pause and resume the spinner around confirm and return the choice', async () => {
    const { io } = createMockProviderIO({ 'Proceed?': 'true' });
    const { spinner, fake, events } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = true;

    const ok = await wrapped.confirm('Proceed?');

    expect(ok).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['stop', 'start']);
  });

  it('should pause and resume the spinner around choose and return the option', async () => {
    const { io } = createMockProviderIO({ 'Pick one': 'b' });
    const { spinner, fake, events } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = true;

    const picked = await wrapped.choose('Pick one', ['a', 'b', 'c']);

    expect(picked).toBe('b');
    expect(events.map((e) => e.kind)).toEqual(['stop', 'start']);
  });

  it('should not restart the spinner after a prompt when it was idle', async () => {
    const { io } = createMockProviderIO({ 'Vault name?': 'docs' });
    const { spinner, fake, events } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);
    fake.isSpinning = false;

    await wrapped.ask('Vault name?');

    expect(events).toEqual([]);
    expect(fake.isSpinning).toBe(false);
  });

  // ─── info / progress ──────────────────────────────────────────────────────

  it('should write info text onto the spinner line instead of delegating', () => {
    const { io, logs } = createMockProviderIO();
    const { spinner, fake } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);

    wrapped.info('connecting to provider');

    expect(fake.text).toContain('connecting to provider');
    // info is rendered on the spinner line, never pushed to the io log.
    expect(logs).toEqual([]);
  });

  it('should render progress label and rounded percent on the spinner line', () => {
    const { io } = createMockProviderIO();
    const { spinner, fake } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(io, spinner);

    wrapped.progress('uploading', 49.6);

    expect(fake.text).toContain('uploading');
    expect(fake.text).toContain('50%');
  });

  // ─── passthrough ──────────────────────────────────────────────────────────

  it('should preserve non-overridden io fields (lang, workDir, debug)', () => {
    const baseIo = createCliProviderIO('/tmp/vault');
    const { spinner } = makeFakeSpinner({ length: 0 });
    const wrapped = createSpinnerIo(baseIo, spinner);

    expect(wrapped.lang).toBe(baseIo.lang);
    expect(wrapped.workDir).toBe('/tmp/vault');
    expect(typeof wrapped.debug).toBe('function');
  });
});
