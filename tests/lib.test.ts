import { describe, expect, it } from 'vitest';
import { IdentityDeclinedError as CoreIdentityDeclinedError, ProviderError as CoreProviderError, isIdentityDeclined } from '../src/core/errors.js';
import { IdentityDeclinedError, ProviderError } from '../src/lib.js';

// `bfs-vault/provider` is the only surface an external adapter can import, so a
// signal the CLI reacts to has to be reachable from it - otherwise built-in
// adapters get a channel an external one does not have.
describe('bfs-vault/provider', () => {
  it('should export the class an adapter throws when the operator refuses a server identity', () => {
    expect(IdentityDeclinedError).toBe(CoreIdentityDeclinedError);
    expect(new IdentityDeclinedError('refused')).toBeInstanceOf(ProviderError);
    expect(ProviderError).toBe(CoreProviderError);
  });

  it('should recognise the refusal through a subclass an adapter defines', () => {
    class AdapterDecline extends IdentityDeclinedError {}

    expect(isIdentityDeclined(new AdapterDecline('refused'))).toBe(true);
    expect(isIdentityDeclined(new ProviderError('unreachable'))).toBe(false);
    expect(isIdentityDeclined('refused')).toBe(false);
  });
});
