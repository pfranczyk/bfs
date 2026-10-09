import { describe, expect, it } from 'vitest';
// Side-effect import: register built-in providers so the spec parser resolves
// `local:` / `ftp:` factories the same way the production CLI does.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';
import { validateProviderIdsUnique } from '../../src/cli/parse-provider-spec.js';

describe('validateProviderIdsUnique', () => {
  it('should throw when newIds contains an internal duplicate', () => {
    expect(() => validateProviderIdsUnique(['p1', 'p2', 'p1'])).toThrow();
  });

  it('should name the colliding id in the message on an internal duplicate', () => {
    let message = '';
    try {
      validateProviderIdsUnique(['p1', 'p2', 'p1']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('p1');
  });

  it('should throw when a newId collides with an existing config id', () => {
    expect(() => validateProviderIdsUnique(['disk-4'], ['disk-1', 'disk-2', 'disk-4'])).toThrow();
  });

  it('should name the colliding id in the message on an existing-config collision', () => {
    let message = '';
    try {
      validateProviderIdsUnique(['disk-4'], ['disk-1', 'disk-2', 'disk-4']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('disk-4');
  });

  it('should not throw when all newIds are unique and no existing ids are given', () => {
    expect(() => validateProviderIdsUnique(['p1', 'p2', 'p3'])).not.toThrow();
  });

  it('should not throw when newIds are unique and disjoint from existing ids', () => {
    expect(() => validateProviderIdsUnique(['p4', 'p5'], ['p1', 'p2', 'p3'])).not.toThrow();
  });

  it('should not throw for an empty newIds list', () => {
    expect(() => validateProviderIdsUnique([])).not.toThrow();
  });
});
