import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en.js';
import type { Strings } from '../../src/i18n/index.js';
import { fmt, getLang, setLang, t } from '../../src/i18n/index.js';
import { pl } from '../../src/i18n/pl.js';

afterEach(() => {
  setLang('en');
});

describe('setLang / getLang', () => {
  it('should default to "en"', () => {
    expect(getLang()).toBe('en');
  });

  it('should switch to "pl"', () => {
    setLang('pl');
    expect(getLang()).toBe('pl');
  });

  it('should fall back to "en" for unknown language', () => {
    setLang('unknown-lang');
    expect(getLang()).toBe('en');
  });
});

describe('t()', () => {
  it('should return English by default', () => {
    expect(t('health_healthy')).toBe('✓ healthy');
  });

  it('should return Polish after setLang("pl")', () => {
    setLang('pl');
    expect(t('health_healthy')).toBe('✓ zdrowy');
  });

  it('should return English after setLang("unknown")', () => {
    setLang('xyz');
    expect(t('health_damaged')).toBe('✗ damaged');
  });
});

describe('fmt()', () => {
  it('should replace %s placeholders in order', () => {
    setLang('en');
    expect(fmt('init_found_files', '42', '1.5 MB')).toBe(
      'Found 42 file(s) (1.5 MB)',
    );
  });

  it('should work in Polish', () => {
    setLang('pl');
    expect(fmt('init_found_files', '7', '200 KB')).toBe(
      'Znaleziono 7 plik(ów) (200 KB)',
    );
  });

  it('should replace multiple %s in order', () => {
    setLang('en');
    expect(fmt('scheme_requires', '3', '1', '4', '3')).toContain('3/1');
  });
});

describe('translation completeness', () => {
  const enKeys = Object.keys(en) as (keyof Strings)[];
  const plKeys = Object.keys(pl) as (keyof Strings)[];

  it('pl should have all keys that en has', () => {
    const missing = enKeys.filter((k) => !plKeys.includes(k));
    expect(missing).toEqual([]);
  });

  it('en should have all keys that pl has', () => {
    const extra = plKeys.filter((k) => !enKeys.includes(k));
    expect(extra).toEqual([]);
  });

  it('all English values should be non-empty strings', () => {
    for (const key of enKeys) {
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  it('all Polish values should be non-empty strings', () => {
    for (const key of plKeys) {
      expect(typeof pl[key]).toBe('string');
      expect(pl[key].length).toBeGreaterThan(0);
    }
  });
});
