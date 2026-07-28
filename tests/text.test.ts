import { describe, expect, it } from 'vitest';
import { matchKey, similarity, normalizeUrl, factKey, truncate, sha256 } from '../src/server/lib/text.js';

describe('matchKey — first-pass project deduplication', () => {
  it('collapses filler words so the same project matches under different phrasing', () => {
    expect(matchKey('New Central Fire Station Project')).toBe(matchKey('Central Fire Station'));
  });

  it('is word-order insensitive', () => {
    expect(matchKey('Fire Station Central')).toBe(matchKey('Central Fire Station'));
  });

  it('ignores punctuation and case', () => {
    expect(matchKey('ZACHARY HIGH — Gymnasium!')).toBe(matchKey('zachary high gymnasium'));
  });

  it('does not collapse genuinely different projects', () => {
    expect(matchKey('Zachary High School')).not.toBe(matchKey('Central Library'));
  });

  it('returns empty for input that is entirely filler, so it cannot false-match', () => {
    // Two unrelated all-filler names must not be treated as the same project
    // downstream; scanSource guards on key.length > 0 for exactly this reason.
    expect(matchKey('The New Project')).toBe('');
  });
});

describe('similarity — shortlisting before paying for an AI match call', () => {
  it('scores a renamed project above the 0.28 shortlist threshold', () => {
    const score = similarity('New Central Fire Station', 'Fire Station No. 3 Replacement');
    expect(score).toBeGreaterThan(0.28);
  });

  it('scores two projects at the same facility highly', () => {
    expect(similarity('Zachary High School Addition', 'Zachary High School Gymnasium')).toBeGreaterThan(0.5);
  });

  it('scores unrelated projects at zero so no AI call is made', () => {
    expect(similarity('Zachary High School', 'Central Library Renovation')).toBe(0);
  });

  it('is symmetric', () => {
    const a = similarity('Baker Branch Library', 'Library Branch at Baker');
    const b = similarity('Library Branch at Baker', 'Baker Branch Library');
    expect(a).toBe(b);
  });

  it('handles empty input without dividing by zero', () => {
    expect(similarity('', 'anything')).toBe(0);
    expect(Number.isNaN(similarity('', ''))).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('strips tracking params, empty query and trailing slash', () => {
    expect(normalizeUrl('https://ex.com/agendas/?utm_source=x&utm_campaign=y#top')).toBe(
      'https://ex.com/agendas',
    );
  });

  it('keeps meaningful query params', () => {
    expect(normalizeUrl('https://ex.com/search?id=42')).toBe('https://ex.com/search?id=42');
  });

  it('preserves a bare-host trailing slash', () => {
    expect(normalizeUrl('https://ex.com/')).toBe('https://ex.com/');
  });

  it('returns malformed input unchanged rather than throwing', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://ex.com/a/?utm_source=z');
    expect(normalizeUrl(once)).toBe(once);
  });
});

describe('factKey — drives fact supersession', () => {
  it('is stable across label casing and punctuation', () => {
    expect(factKey('timeline', 'Bid Opening')).toBe(factKey('timeline', 'bid  opening'));
  });

  it('separates the same label in different categories', () => {
    expect(factKey('timeline', 'Budget')).not.toBe(factKey('budget', 'Budget'));
  });
});

describe('misc helpers', () => {
  it('truncate leaves short text alone and marks long text', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdefghij', 4)).toContain('truncated');
  });

  it('sha256 is stable and differs on change', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});
