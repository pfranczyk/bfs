import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushResult } from '../../src/types/index.js';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

// Shared spinner-event log and fake-spinner factory, hoisted so both the
// `vi.mock('ora', ...)` factory and the test body see the same `events` array.
const { events, makeFakeSpinner } = vi.hoisted(() => {
  const events: string[] = [];
  const makeFakeSpinner = () => {
    const spinner = {
      _text: '',
      isSpinning: false,
      get text(): string {
        return spinner._text;
      },
      set text(value: string) {
        spinner._text = value;
      },
      start(_text?: string) {
        spinner.isSpinning = true;
        events.push('start');
        return spinner;
      },
      stop() {
        spinner.isSpinning = false;
        events.push('stop');
        return spinner;
      },
      succeed(_text?: string) {
        return spinner;
      },
      warn(_text?: string) {
        return spinner;
      },
      fail(_text?: string) {
        return spinner;
      },
    };
    return spinner;
  };
  return { events, makeFakeSpinner };
});

vi.mock('ora', () => ({ default: (_opts?: unknown) => makeFakeSpinner() }));
vi.mock('../../src/vault/vault-manager.js', () => ({ push: vi.fn() }));
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
    Separator: class {
      type = 'separator';
    },
  },
  Separator: class {
    type = 'separator';
  },
}));

import { push } from '../../src/vault/vault-manager.js';

const mockPush = vi.mocked(push);

function okResult(overrides: Partial<PushResult> = {}): PushResult {
  return { version: 1, file_count: 2, total_size: 100, skipped: [], uploaded_count: 3, failed: [], health: VersionHealth.Healthy, ...overrides };
}

// Guards against a regression where push.ts drops the wrappedIo `warn`
// override: push must pause the ora spinner around a provider warn so the
// warning does not interleave with the live spinner line. With the override
// missing, io.warn writes straight to console.warn while the spinner keeps
// running — no spinner.stop()/start() pair brackets the warn. pull.ts has the
// correct override; this test pins the same behaviour for push.
describe('push spinner warn', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
    events.length = 0;
  });

  it('should pause the spinner around a provider warn during push', async () => {
    mockPush.mockImplementation(async (_dir, opts) => {
      opts.io.warn('shard retry');
      return okResult();
    });

    const result = await runCmd(['push']);

    expect(result).toBe('ok');
    // The warn handling must stop the spinner, then restart it.
    expect(events).toContain('stop');
    const stopIdx = events.indexOf('stop');
    const startAfter = events.indexOf('start', stopIdx + 1);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startAfter).toBeGreaterThan(stopIdx);
  });
});
