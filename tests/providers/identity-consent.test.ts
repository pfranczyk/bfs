import { describe, expect, it } from 'vitest';
import { linkConsentScope, recallIdentityConsent, rememberIdentityConsent } from '../../src/providers/identity-consent.js';
import { createMockProviderIO } from '../../src/providers/provider.js';

describe('identity consent memory', () => {
  it('should return null for a target and fingerprint the operator was not asked about', () => {
    const { io } = createMockProviderIO();

    expect(recallIdentityConsent(io, 'user@host:22', 'SHA256:a')).toBeNull();
  });

  it('should remember an acceptance and a refusal for the same io', () => {
    const { io } = createMockProviderIO();

    rememberIdentityConsent(io, 'user@host:22', 'SHA256:a', true);
    rememberIdentityConsent(io, 'user@other:22', 'SHA256:b', false);

    expect(recallIdentityConsent(io, 'user@host:22', 'SHA256:a')).toBe(true);
    expect(recallIdentityConsent(io, 'user@other:22', 'SHA256:b')).toBe(false);
  });

  it('should key the answer by target and fingerprint, not by either alone', () => {
    const { io } = createMockProviderIO();

    rememberIdentityConsent(io, 'user@host:22', 'SHA256:a', true);

    expect(recallIdentityConsent(io, 'user@host:22', 'SHA256:different')).toBeNull();
    expect(recallIdentityConsent(io, 'user@elsewhere:22', 'SHA256:a')).toBeNull();
  });

  it('should not carry an answer into another command (another io)', () => {
    const { io: first } = createMockProviderIO();
    const { io: second } = createMockProviderIO();

    rememberIdentityConsent(first, 'user@host:22', 'SHA256:a', true);

    expect(recallIdentityConsent(second, 'user@host:22', 'SHA256:a')).toBeNull();
  });

  it('should share the memory between an io and a wrapper linked to it, in both directions', () => {
    const { io: base } = createMockProviderIO();
    const wrapper = { ...base };
    linkConsentScope(wrapper, base);

    rememberIdentityConsent(base, 'user@host:22', 'SHA256:a', true);
    rememberIdentityConsent(wrapper, 'user@host:22', 'SHA256:b', false);

    expect(recallIdentityConsent(wrapper, 'user@host:22', 'SHA256:a')).toBe(true);
    expect(recallIdentityConsent(base, 'user@host:22', 'SHA256:b')).toBe(false);
  });
});
