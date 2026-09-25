import { describe, expect, it } from 'vitest';
import {
  countWords,
  normalizeTitle,
  normalizeTags,
  sha256Prefix,
  validateExpandedCard,
} from '../src/generation/dedup';

describe('normalizeTitle', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeTitle('  Loss   Aversion ')).toBe('loss aversion');
    expect(normalizeTitle('Deep\tWork\n  Basics')).toBe('deep work basics');
  });

  it('is idempotent', () => {
    const once = normalizeTitle('  THE   Zeigarnik   Effect ');
    expect(normalizeTitle(once)).toBe(once);
  });

  it('keeps punctuation (plan defines only lower/trim/collapse)', () => {
    expect(normalizeTitle("Parkinson's Law!")).toBe("parkinson's law!");
  });
});

describe('sha256Prefix', () => {
  it('is deterministic for identical input', async () => {
    const a = await sha256Prefix('loss aversion');
    const b = await sha256Prefix('loss aversion');
    expect(a).toBe(b);
  });

  it('is exactly 16 lowercase hex chars', async () => {
    const hash = await sha256Prefix('the zeigarnik effect');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across repeated calls with mixed input formatting after normalization', async () => {
    const a = await sha256Prefix(normalizeTitle('Loss Aversion'));
    const b = await sha256Prefix(normalizeTitle('loss  aversion '));
    expect(a).toBe(b);
  });

  it('differs for different titles', async () => {
    const a = await sha256Prefix('loss aversion');
    const b = await sha256Prefix('sunk cost fallacy');
    expect(a).not.toBe(b);
  });
});

describe('countWords', () => {
  it('returns 0 for empty/whitespace input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });

  it('counts words separated by any whitespace', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  one\ttwo\nthree  ')).toBe(3);
  });

  it('respects the 50/200 word-count boundaries', () => {
    expect(countWords('word '.repeat(49).trim())).toBe(49);
    expect(countWords('word '.repeat(50).trim())).toBe(50);
    expect(countWords('word '.repeat(200).trim())).toBe(200);
    expect(countWords('word '.repeat(201).trim())).toBe(201);
  });
});

describe('normalizeTags', () => {
  it('trims, drops empties and non-strings, dedupes case-insensitively, caps at 3', () => {
    expect(normalizeTags([' Mindset ', 'mindset', 'Finance', 42, null, '', 'Tech', 'Extra'])).toEqual([
      'Mindset',
      'Finance',
      'Tech',
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeTags('Mindset')).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe('validateExpandedCard', () => {
  const word = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const validCard = {
    title: '  The Zeigarnik Effect  ',
    body: word(80),
    source: ' Zeigarnik, 1927 ',
    tags: ['Mindset'],
  };

  it('accepts a valid card and trims fields', () => {
    const card = validateExpandedCard(validCard);
    expect(card).not.toBeNull();
    expect(card!.title).toBe('The Zeigarnik Effect');
    expect(card!.source).toBe('Zeigarnik, 1927');
    expect(card!.tags).toEqual(['Mindset']);
  });

  it('accepts bodies at the 50 and 200 word boundaries', () => {
    expect(validateExpandedCard({ ...validCard, body: word(50) })).not.toBeNull();
    expect(validateExpandedCard({ ...validCard, body: word(200) })).not.toBeNull();
  });

  it('rejects bodies under 50 words', () => {
    expect(validateExpandedCard({ ...validCard, body: word(49) })).toBeNull();
    expect(validateExpandedCard({ ...validCard, body: 'too short' })).toBeNull();
  });

  it('rejects bodies over 200 words', () => {
    expect(validateExpandedCard({ ...validCard, body: word(201) })).toBeNull();
  });

  it('rejects empty title, body, or source', () => {
    expect(validateExpandedCard({ ...validCard, title: '   ' })).toBeNull();
    expect(validateExpandedCard({ ...validCard, body: '' })).toBeNull();
    expect(validateExpandedCard({ ...validCard, source: '  ' })).toBeNull();
    expect(validateExpandedCard({ ...validCard, source: 42 })).toBeNull();
  });

  it('rejects cards with no usable tags', () => {
    expect(validateExpandedCard({ ...validCard, tags: [] })).toBeNull();
    expect(validateExpandedCard({ ...validCard, tags: 'Mindset' })).toBeNull();
    expect(validateExpandedCard({ ...validCard, tags: ['', '   '] })).toBeNull();
  });

  it('normalizes tags on the way through', () => {
    const card = validateExpandedCard({ ...validCard, tags: ['mindset', 'MINDSET', 'Finance', 'Tech', 'Extra'] });
    expect(card!.tags).toEqual(['mindset', 'Finance', 'Tech']);
  });

  it('rejects non-object input', () => {
    expect(validateExpandedCard(null)).toBeNull();
    expect(validateExpandedCard('card')).toBeNull();
    expect(validateExpandedCard(42)).toBeNull();
  });
});
