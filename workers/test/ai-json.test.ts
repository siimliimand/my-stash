import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/generation/ai-client';
import {
  parseApprovedList,
  parseCardList,
  parseTitleList,
  validateExpandedCards,
  validateTitleCandidates,
} from '../src/generation/dedup';

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a plain JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('parses fenced ```json blocks', () => {
    const fenced = '```json\n{\n  "titles": []\n}\n```';
    expect(extractJson(fenced)).toEqual({ titles: [] });
  });

  it('parses fenced blocks with no language tag', () => {
    expect(extractJson('```\n["x"]\n```')).toEqual(['x']);
  });

  it('parses JSON with leading prose', () => {
    expect(extractJson('Here is the JSON you asked for:\n{"ok": true}')).toEqual({ ok: true });
  });

  it('parses JSON with trailing prose', () => {
    expect(extractJson('["a","b"]\n\nHope this helps!')).toEqual(['a', 'b']);
  });

  it('captures the full outer object when it contains nested braces', () => {
    const nested = 'prefix {"outer": {"inner": [1, {"deep": 2}]}, "n": 3} suffix';
    expect(extractJson(nested)).toEqual({ outer: { inner: [1, { deep: 2 }] }, n: 3 });
  });

  it('distinguishes object vs array payloads', () => {
    expect(extractJson('{"approved": [1]}')).toEqual({ approved: [1] });
    expect(extractJson('[{"title": "x"}]')).toEqual([{ title: 'x' }]);
  });

  it('returns null for garbage, empty, or brace-less input', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('no json here at all')).toBeNull();
    expect(extractJson('{not json')).toBeNull();
    expect(extractJson('{"unclosed": true')).toBeNull();
  });
});

describe('validateTitleCandidates / parseTitleList', () => {
  const good = {
    title: '  The Dunning-Kruger Effect ',
    category: ' Mindset ',
    subcategory: 'Cognitive Biases',
    topic_slug: 'dunning-kruger-effect',
  };

  it('accepts a valid candidate list and trims fields', () => {
    const list = validateTitleCandidates([good, { title: 'X', category: 'C', subcategory: 'S', topic_slug: 'x' }]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      title: 'The Dunning-Kruger Effect',
      category: 'Mindset',
      subcategory: 'Cognitive Biases',
      topic_slug: 'dunning-kruger-effect',
    });
  });

  it('accepts the {"titles": [...]} wrapper the model is asked to produce', () => {
    expect(validateTitleCandidates({ titles: [good] })).toHaveLength(1);
  });

  it('drops entries with empty or non-string fields', () => {
    const list = validateTitleCandidates([
      good,
      { title: '', category: 'A', subcategory: 'B', topic_slug: 'c' },
      { title: 'ok', category: 42, subcategory: 'B', topic_slug: 'c' },
      { title: 'ok', category: 'A', subcategory: null, topic_slug: 'c' },
      'not an object',
      null,
    ]);
    expect(list).toHaveLength(1);
  });

  it('de-duplicates within the batch by normalized title', () => {
    const list = validateTitleCandidates([
      good,
      { ...good, title: 'the dunning-kruger   effect' },
      { ...good, title: 'A Different Idea', topic_slug: 'different-idea' },
    ]);
    expect(list).toHaveLength(2);
  });

  it('parseTitleList returns null for unusable structure (triggers retry), [] for empty-but-valid', () => {
    expect(parseTitleList('nope')).toBeNull();
    expect(parseTitleList({ wrong: 'shape' })).toBeNull();
    expect(parseTitleList([])).toEqual([]);
    expect(parseTitleList({ titles: [] })).toEqual([]);
  });
});

describe('parseApprovedList (near-dedup response)', () => {
  it('accepts {"approved": [...objects...]}', () => {
    expect(parseApprovedList({ approved: [{ title: 'A' }, { title: 'B' }] })).toEqual(['A', 'B']);
  });

  it('accepts bare title strings inside approved', () => {
    expect(parseApprovedList({ approved: ['A', '  ', 42] })).toEqual(['A']);
  });

  it('accepts a top-level array as well', () => {
    expect(parseApprovedList([{ title: 'Solo' }])).toEqual(['Solo']);
  });

  it('returns null for unusable structure', () => {
    expect(parseApprovedList('nope')).toBeNull();
    expect(parseApprovedList({ nope: true })).toBeNull();
  });
});

describe('parseCardList / validateExpandedCards', () => {
  const card = (title: string, words: number) => ({
    title,
    body: Array.from({ length: words }, (_, i) => `w${i}`).join(' '),
    source: 'Someone, 1999',
    tags: ['Mindset'],
  });

  it('validates a good list and drops invalid cards', () => {
    const cards = validateExpandedCards([card('A', 80), card('B', 10), card('', 80), card('C', 300)]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe('A');
  });

  it('de-duplicates repeated titles within the batch', () => {
    const cards = validateExpandedCards([card('Same Title', 80), card('Same  Title', 90)]);
    expect(cards).toHaveLength(1);
  });

  it('parseCardList returns null when there is no card array at all', () => {
    expect(parseCardList('nope')).toBeNull();
    expect(parseCardList({ foo: [] })).toBeNull();
    expect(parseCardList([])).toEqual([]);
    // tolerates a {"cards": [...]} wrapper too
    expect(parseCardList({ cards: [card('A', 80)] })).toHaveLength(1);
  });
});
