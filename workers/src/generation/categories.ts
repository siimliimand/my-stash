/** The canonical card categories and their enforcement. The title AI is
 * pointed at these via the coverage map, but the 2026-09-26 production run
 * showed it freewheels ("Technology", "History", "Philosophy") when the
 * string it stamps on a candidate is trusted — so candidates are normalized
 * against an explicit alias map, and anything still non-canonical is dropped
 * (the prompt's surplus quota absorbs the loss). */

import type { TitleCandidate } from '../lib/types';

export const CANONICAL_CATEGORIES = [
  'Health & Wellbeing',
  'Leadership & Communication',
  'Mindset',
  'Finance',
  'Tech',
  'Creativity',
  'Productivity',
  'Science',
] as const;

/** Cards each canonical category must contribute per day (2026-09-26 product
 * spec change: the old free-for-all 50/day let the model skew the batch toward
 * whichever category it fancied — a fixed per-category quota guarantees an
 * even spread). */
export const CARDS_PER_CATEGORY_PER_DAY = 2;

/** The daily batch target when no `requested` override is given: every
 * canonical category contributes its quota (8 x 2 = 16). */
export const DEFAULT_DAILY_REQUESTED = CANONICAL_CATEGORIES.length * CARDS_PER_CATEGORY_PER_DAY;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/**
 * Predictable shorthand the model emits instead of a canonical name. Each
 * entry appears verbatim in the plan (§12 domain/tag lists, §7 example
 * output). Case-insensitive exact lookup only — no fuzzy matching; anything
 * not listed here and not canonical is dropped by the pipeline.
 */
const CATEGORY_ALIASES: Readonly<Record<string, CanonicalCategory>> = {
  technology: 'Tech',
  health: 'Health & Wellbeing',
  leadership: 'Leadership & Communication',
  communication: 'Leadership & Communication',
};

/** Canonical spelling for a category string, or null when it is neither a
 * canonical name (case-insensitively) nor a known alias. */
export function canonicalCategory(raw: string): CanonicalCategory | null {
  const key = raw.trim().toLowerCase();
  const canonical = CANONICAL_CATEGORIES.find((category) => category.toLowerCase() === key);
  if (canonical !== undefined) return canonical;
  return CATEGORY_ALIASES[key] ?? null;
}

export interface CanonicalizedCandidates {
  /** Candidates whose category is canonical (alias spellings rewritten). */
  candidates: TitleCandidate[];
  /** Emitted category names of the dropped candidates, one per candidate. */
  droppedCategories: string[];
}

/**
 * Alias-normalize then drop: candidates carrying a canonical category (in any
 * casing) or a known alias pass through with the canonical spelling written
 * back; everything else is dropped and counted. The free-text subcategory is
 * deliberately left untouched — only categories are enumerated.
 */
export function enforceCanonicalCategories(candidates: TitleCandidate[]): CanonicalizedCandidates {
  const kept: TitleCandidate[] = [];
  const droppedCategories: string[] = [];
  for (const candidate of candidates) {
    const category = canonicalCategory(candidate.category);
    if (category === null) {
      droppedCategories.push(candidate.category);
      continue;
    }
    kept.push(category === candidate.category ? candidate : { ...candidate, category });
  }
  return { candidates: kept, droppedCategories };
}
