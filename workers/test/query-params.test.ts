import { describe, expect, it } from 'vitest';
import { cardsCacheKey, parseCardQuery } from '../src/routes/cards';
import { secureCompare } from '../src/routes/admin';
import { chunkArray } from '../src/lib/db';

describe('parseCardQuery', () => {
  const parse = (query: string): ReturnType<typeof parseCardQuery> => parseCardQuery(new URL(`https://api.example.test/api/cards${query}`));

  it('defaults to page 1, limit 20 with no params', () => {
    expect(parse('')).toEqual({ page: 1, limit: 20, category: undefined, tag: undefined, date: undefined });
  });

  it('clamps page to >= 1 and non-numeric page to the default', () => {
    expect(parse('?page=0').page).toBe(1);
    expect(parse('?page=-5').page).toBe(1);
    expect(parse('?page=abc').page).toBe(1);
    expect(parse('?page=1.9').page).toBe(1);
    expect(parse('?page=7').page).toBe(7);
  });

  it('clamps limit into [1, 50] with default 20', () => {
    expect(parse('?limit=0').limit).toBe(1);
    expect(parse('?limit=-3').limit).toBe(1);
    expect(parse('?limit=100').limit).toBe(50);
    expect(parse('?limit=abc').limit).toBe(20);
    expect(parse('?limit=25').limit).toBe(25);
  });

  it('keeps category and tag filters', () => {
    const q = parse('?category=Mindset&tag=Finance');
    expect(q.category).toBe('Mindset');
    expect(q.tag).toBe('Finance');
  });

  it('treats blank category/tag as absent', () => {
    expect(parse('?category=&tag=').category).toBeUndefined();
    expect(parse('?category=&tag=').tag).toBeUndefined();
  });

  it('accepts well-formed dates and ignores malformed ones', () => {
    expect(parse('?date=2026-10-05').date).toBe('2026-10-05');
    expect(parse('?date=tomorrow').date).toBeUndefined();
    expect(parse('?date=2026-10').date).toBeUndefined();
    expect(parse('?date=').date).toBeUndefined();
  });
});

describe('cardsCacheKey', () => {
  const key = async (query: string) => cardsCacheKey(parseCardQuery(new URL(`https://api.example.test/api/cards${query}`)));

  it('is stable for the same param combination', async () => {
    expect(await key('?page=2&limit=10&category=Mindset')).toBe(await key('?category=Mindset&page=2&limit=10'));
    expect(await key('')).toBe(await key('?page=1&limit=20'));
  });

  it('differs when any parameter differs', async () => {
    const keys = await Promise.all([
      key(''),
      key('?page=2'),
      key('?limit=50'),
      key('?category=Mindset'),
      key('?category=Finance'),
      key('?tag=Mindset'),
      key('?date=2026-10-05'),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('always emits the api-cache:cards: prefix and 16-hex suffix', async () => {
    expect(await key('?page=3')).toMatch(/^api-cache:cards:[0-9a-f]{16}$/);
  });
});

describe('secureCompare (admin bearer check)', () => {
  it('accepts the exact bearer value', () => {
    expect(secureCompare('Bearer hunter2', 'Bearer hunter2')).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(secureCompare('Bearer hunter2', 'Bearer hunter3')).toBe(false);
  });

  it('rejects a missing header (empty string)', () => {
    expect(secureCompare('', 'Bearer hunter2')).toBe(false);
  });

  it('rejects wrong scheme casing and malformed values', () => {
    expect(secureCompare('bearer hunter2', 'Bearer hunter2')).toBe(false);
    expect(secureCompare('hunter2', 'Bearer hunter2')).toBe(false);
    expect(secureCompare('Bearer hunter2 ', 'Bearer hunter2')).toBe(false);
    expect(secureCompare('Bearer ', 'Bearer hunter2')).toBe(false);
  });

  it('rejects different-length values', () => {
    expect(secureCompare('Bearer a', 'Bearer abc')).toBe(false);
    expect(secureCompare('', 'x')).toBe(false);
  });
});

describe('chunkArray (D1 parameter batching)', () => {
  it('splits evenly and handles the remainder chunk', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 10)).toEqual([]);
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('keeps chunks within the D1 100-parameter budget when chunking 60 hashes at 90', () => {
    const chunks = chunkArray(Array.from({ length: 60 }, (_, i) => i), 90);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(60);
  });
});
