import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPIC_MAP,
  finalizeMergedMap,
  mergeTopicsDeterministic,
  validateMergedMap,
  validateTopicMap,
} from '../src/generation/topic-map';
import type { NewTopic, TopicCoverageMap } from '../src/lib/types';

const validMap: TopicCoverageMap = {
  version: 3,
  updatedAt: '2026-09-01T00:00:00.000Z',
  totalCards: 100,
  recentTopicSlugs: ['old-a', 'old-b'],
  categories: {
    Mindset: { 'Cognitive Biases': ['loss aversion'], 'Empty Sub': [] },
    Finance: {},
  },
};

describe('validateTopicMap', () => {
  it('accepts the baked-in DEFAULT_TOPIC_MAP (same object as seed/seed-map.json)', () => {
    expect(validateTopicMap(DEFAULT_TOPIC_MAP)).not.toBeNull();
    expect(DEFAULT_TOPIC_MAP.version).toBe(1);
    expect(DEFAULT_TOPIC_MAP.totalCards).toBe(0);
    expect(DEFAULT_TOPIC_MAP.recentTopicSlugs).toEqual([]);
    expect(Object.keys(DEFAULT_TOPIC_MAP.categories)).toContain('Health & Wellbeing');
  });

  it('accepts a well-formed map and normalizes missing recentTopicSlugs to []', () => {
    const { recentTopicSlugs, ...withoutRecent } = validMap;
    const parsed = validateTopicMap(withoutRecent);
    expect(parsed).not.toBeNull();
    expect(recentTopicSlugs).toEqual(['old-a', 'old-b']);
    expect(parsed!.recentTopicSlugs).toEqual([]);
  });

  it('rejects malformed maps', () => {
    expect(validateTopicMap(null)).toBeNull();
    expect(validateTopicMap('map')).toBeNull();
    expect(validateTopicMap({ ...validMap, version: 0 })).toBeNull();
    expect(validateTopicMap({ ...validMap, version: '3' })).toBeNull();
    expect(validateTopicMap({ ...validMap, totalCards: -1 })).toBeNull();
    expect(validateTopicMap({ ...validMap, totalCards: 1.5 })).toBeNull();
    expect(validateTopicMap({ ...validMap, updatedAt: 42 })).toBeNull();
    expect(validateTopicMap({ ...validMap, categories: 'nope' })).toBeNull();
    expect(validateTopicMap({ ...validMap, categories: ['Mindset'] })).toBeNull();
    // slug lists must be arrays of non-empty strings
    expect(validateTopicMap({ ...validMap, categories: { Mindset: { Sub: 'not-an-array' } } })).toBeNull();
    expect(validateTopicMap({ ...validMap, categories: { Mindset: { Sub: [42] } } })).toBeNull();
    expect(validateTopicMap({ ...validMap, categories: { Mindset: { Sub: ['ok', '   '] } } })).toBeNull();
    // subcategories must be an object, not an array
    expect(validateTopicMap({ ...validMap, categories: { Mindset: ['Cognitive Biases'] } })).toBeNull();
    // recentTopicSlugs must be an array of strings when present
    expect(validateTopicMap({ ...validMap, recentTopicSlugs: 'old-a' })).toBeNull();
    expect(validateTopicMap({ ...validMap, recentTopicSlugs: [7] })).toBeNull();
  });
});

describe('mergeTopicsDeterministic', () => {
  const topics: NewTopic[] = [
    { category: 'Mindset', subcategory: 'Cognitive Biases', slug: 'confirmation bias' },
    { category: 'Philosophy', subcategory: 'Stoicism', slug: 'dichotomy of control' },
    { category: 'Philosophy', subcategory: 'Stoicism', slug: 'dichotomy of control' }, // dupe
  ];

  it('creates missing categories and subcategories', () => {
    const merged = mergeTopicsDeterministic(validMap, topics);
    expect(merged.categories.Philosophy.Stoicism).toEqual(['dichotomy of control']);
  });

  it('appends to existing subcategories without duplicating slugs', () => {
    const merged = mergeTopicsDeterministic(validMap, topics);
    expect(merged.categories.Mindset['Cognitive Biases']).toEqual(['loss aversion', 'confirmation bias']);
  });

  it('preserves existing entries, including empty slug arrays', () => {
    const merged = mergeTopicsDeterministic(validMap, topics);
    expect(merged.categories.Mindset['Empty Sub']).toEqual([]);
    expect(merged.categories.Finance).toEqual({});
  });

  it('bumps version by 1 and increments totalCards by the inserted count', () => {
    const merged = mergeTopicsDeterministic(validMap, topics);
    expect(merged.version).toBe(4);
    expect(merged.totalCards).toBe(103);
    expect(merged.updatedAt).not.toBe(validMap.updatedAt);
  });

  it('sets recentTopicSlugs to the last 50 inserted slugs', () => {
    const many: NewTopic[] = Array.from({ length: 60 }, (_, i) => ({
      category: 'Bulk',
      subcategory: 'Sub',
      slug: `slug-${i}`,
    }));
    const merged = mergeTopicsDeterministic(validMap, many);
    expect(merged.recentTopicSlugs).toHaveLength(50);
    expect(merged.recentTopicSlugs[0]).toBe('slug-10');
    expect(merged.recentTopicSlugs[49]).toBe('slug-59');
  });

  it('skips entries with empty category/subcategory/slug', () => {
    const merged = mergeTopicsDeterministic(validMap, [
      { category: '', subcategory: 'S', slug: 'x' },
      { category: 'C', subcategory: '', slug: 'x' },
      { category: 'C', subcategory: 'S', slug: '  ' },
    ]);
    expect(merged.categories.C).toBeUndefined();
    expect(merged.totalCards).toBe(100);
  });

  it('does not mutate the input map', () => {
    const before = JSON.stringify(validMap);
    mergeTopicsDeterministic(validMap, topics);
    expect(JSON.stringify(validMap)).toBe(before);
  });
});

describe('validateMergedMap / finalizeMergedMap', () => {
  const topics: NewTopic[] = [{ category: 'Mindset', subcategory: 'Memory', slug: 'zeigarnik effect' }];
  const goodMerge = (): Record<string, unknown> => {
    const categories = JSON.parse(JSON.stringify(validMap.categories)) as TopicCoverageMap['categories'];
    categories.Mindset = {
      ...categories.Mindset,
      Memory: ['zeigarnik effect'],
    };
    const map = JSON.parse(JSON.stringify(validMap)) as Record<string, unknown>;
    return { ...map, version: 4, categories };
  };

  it('accepts a correct AI merge and overwrites deterministic fields locally', () => {
    const finalized = finalizeMergedMap(goodMerge(), validMap, topics);
    expect(finalized).not.toBeNull();
    expect(finalized!.version).toBe(4);
    expect(finalized!.totalCards).toBe(101);
    expect(finalized!.recentTopicSlugs).toEqual(['zeigarnik effect']);
    // AI-claimed totals are ignored:
    expect(finalizeMergedMap({ ...goodMerge(), totalCards: 99999 }, validMap, topics)!.totalCards).toBe(101);
  });

  it('rejects merges that lose old entries', () => {
    const bad = goodMerge() as Record<string, unknown>;
    const categories = bad.categories as Record<string, Record<string, string[]>>;
    delete categories.Mindset['Cognitive Biases'];
    expect(validateMergedMap(validMap, bad, topics)).toBe(false);
  });

  it('rejects merges missing a new topic', () => {
    expect(validateMergedMap(validMap, goodMerge(), topics)).toBe(true);
    const withoutNew = goodMerge() as Record<string, unknown>;
    const categories = withoutNew.categories as Record<string, Record<string, string[]>>;
    delete categories.Mindset.Memory;
    expect(validateMergedMap(validMap, withoutNew, topics)).toBe(false);
  });

  it('rejects wrong version bumps and structurally invalid maps', () => {
    expect(validateMergedMap(validMap, { ...goodMerge(), version: 5 }, topics)).toBe(false);
    expect(validateMergedMap(validMap, { ...goodMerge(), version: 2 }, topics)).toBe(false);
    expect(validateMergedMap(validMap, 'not a map', topics)).toBe(false);
  });

  it('rejects merges that invent far more slugs than the new topics (runaway guard)', () => {
    // existing total = 1 slug; newTopics.length = 1; slack = 10 -> cap 12.
    const inflated = goodMerge() as Record<string, unknown>;
    const categories = inflated.categories as Record<string, Record<string, string[]>>;
    categories.Mindset.Memory = ['zeigarnik effect', ...Array.from({ length: 12 }, (_, i) => `invented-${i}`)];
    expect(validateMergedMap(validMap, inflated, topics)).toBe(false);

    // Exactly at the cap (1 + 1 + 10 = 12 total slugs) is still accepted.
    const atCap = goodMerge() as Record<string, unknown>;
    const atCapCategories = atCap.categories as Record<string, Record<string, string[]>>;
    atCapCategories.Mindset.Memory = ['zeigarnik effect', ...Array.from({ length: 10 }, (_, i) => `extra-${i}`)];
    expect(validateMergedMap(validMap, atCap, topics)).toBe(true);
  });
});
