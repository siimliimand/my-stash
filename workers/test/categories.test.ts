import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CATEGORIES,
  canonicalCategory,
  enforceCanonicalCategories,
} from '../src/generation/categories';

describe('CANONICAL_CATEGORIES', () => {
  it('holds exactly 8 unique, self-mapping categories', () => {
    expect(CANONICAL_CATEGORIES).toHaveLength(8);
    expect(new Set(CANONICAL_CATEGORIES).size).toBe(8);
    for (const category of CANONICAL_CATEGORIES) {
      expect(canonicalCategory(category)).toBe(category);
    }
  });
});

describe('canonicalCategory', () => {
  it('accepts canonical names case-insensitively and rewrites the spelling', () => {
    expect(canonicalCategory('Tech')).toBe('Tech');
    expect(canonicalCategory('  TECH ')).toBe('Tech');
    expect(canonicalCategory('health & wellbeing')).toBe('Health & Wellbeing');
  });

  it('maps the explicit aliases to their canonical category', () => {
    expect(canonicalCategory('Technology')).toBe('Tech');
    expect(canonicalCategory('technology')).toBe('Tech');
    expect(canonicalCategory('Health')).toBe('Health & Wellbeing');
    expect(canonicalCategory('Leadership')).toBe('Leadership & Communication');
    expect(canonicalCategory('Communication')).toBe('Leadership & Communication');
  });

  it('returns null for anything non-canonical (no fuzzy matching)', () => {
    expect(canonicalCategory('History')).toBeNull();
    expect(canonicalCategory('Philosophy')).toBeNull();
    expect(canonicalCategory('Relationships')).toBeNull();
    expect(canonicalCategory('Tech-ish')).toBeNull();
    expect(canonicalCategory('')).toBeNull();
  });
});

describe('enforceCanonicalCategories', () => {
  it('rewrites aliases, keeps canonical candidates, and counts drops', () => {
    const { candidates, droppedCategories } = enforceCanonicalCategories([
      { title: 'A', category: 'Mindset', subcategory: 'S', topic_slug: 'a' },
      { title: 'B', category: 'Technology', subcategory: 'S', topic_slug: 'b' },
      { title: 'C', category: 'History', subcategory: 'S', topic_slug: 'c' },
      { title: 'D', category: 'Philosophy', subcategory: 'S', topic_slug: 'd' },
    ]);

    expect(candidates.map((c) => c.category)).toEqual(['Mindset', 'Tech']);
    expect(droppedCategories).toEqual(['History', 'Philosophy']);
  });

  it('touches only the category field', () => {
    const { candidates } = enforceCanonicalCategories([
      { title: ' B ', category: 'TECHNOLOGY', subcategory: ' Free Text ', topic_slug: 'b' },
    ]);
    expect(candidates).toEqual([
      { title: ' B ', category: 'Tech', subcategory: ' Free Text ', topic_slug: 'b' },
    ]);
  });

  it('returns the input untouched when every category is already canonical', () => {
    const input = CANONICAL_CATEGORIES.map((category, i) => ({
      title: `T${i}`,
      category,
      subcategory: 'S',
      topic_slug: `t${i}`,
    }));
    expect(enforceCanonicalCategories(input)).toEqual({ candidates: input, droppedCategories: [] });
  });
});
