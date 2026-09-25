/** Topic coverage map: load from KV, validate, merge (AI-assisted with a
 * deterministic local fallback), and persist. See plan §2.1 / §6 step 8. */

import seedMapJson from '../../seed/seed-map.json';
import { getJson, putJson } from '../lib/kv';
import type { Env, NewTopic, TopicCoverageMap } from '../lib/types';

export const TOPIC_MAP_KEY = 'topic-coverage-map';
export const RECENT_SLUGS_CAP = 50;

/**
 * Baked-in default map — the exact same object as seed/seed-map.json
 * (imported, so the two cannot drift). Used when KV has no map (fresh deploys)
 * or the stored map is corrupt (plan §13). Unit test asserts it validates.
 */
export const DEFAULT_TOPIC_MAP = seedMapJson as unknown as TopicCoverageMap;

/**
 * Structural validation. Returns a normalized copy (recentTopicSlugs defaults
 * to [] so pre-extension maps still load) or null when the payload is not a
 * usable map. Never throws.
 */
export function validateTopicMap(raw: unknown): TopicCoverageMap | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) return null;
  if (typeof record.updatedAt !== 'string') return null;
  if (typeof record.totalCards !== 'number' || !Number.isInteger(record.totalCards) || record.totalCards < 0) return null;
  if (typeof record.categories !== 'object' || record.categories === null || Array.isArray(record.categories)) {
    return null;
  }

  const categories: Record<string, Record<string, string[]>> = {};
  for (const [category, subcategories] of Object.entries(record.categories)) {
    if (typeof subcategories !== 'object' || subcategories === null || Array.isArray(subcategories)) return null;
    categories[category] = {};
    for (const [subcategory, slugs] of Object.entries(subcategories)) {
      if (!Array.isArray(slugs)) return null;
      if (!slugs.every((slug) => typeof slug === 'string' && slug.trim().length > 0)) return null;
      categories[category][subcategory] = slugs as string[];
    }
  }

  const recent = record.recentTopicSlugs === undefined ? [] : record.recentTopicSlugs;
  if (!Array.isArray(recent) || !recent.every((slug) => typeof slug === 'string')) return null;

  return {
    version: record.version,
    updatedAt: record.updatedAt,
    totalCards: record.totalCards,
    recentTopicSlugs: recent.slice(-RECENT_SLUGS_CAP),
    categories,
  };
}

export interface LoadedTopicMap {
  map: TopicCoverageMap;
  /** True when KV had no usable map and the baked-in default is in use. */
  usedFallback: boolean;
}

/** Step 2: load the map. KV miss/corruption falls back to DEFAULT_TOPIC_MAP. */
export async function loadTopicMap(env: Env): Promise<LoadedTopicMap> {
  const map = await getJson(env.KV, TOPIC_MAP_KEY, validateTopicMap);
  if (map !== null) return { map, usedFallback: false };
  return { map: DEFAULT_TOPIC_MAP, usedFallback: true };
}

/** Step 8: persist the updated map. Never throws; returns success flag. */
export function saveTopicMap(env: Env, map: TopicCoverageMap): Promise<boolean> {
  return putJson(env.KV, TOPIC_MAP_KEY, map);
}

function isEmptyString(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Deterministic local merge — does exactly what MAP_UPDATE_PROMPT asks,
 * in pure code. Used when the AI merge fails or returns an invalid map
 * (cards are already committed at this point; the map update must not fail
 * the batch). Pure: does not mutate the input map (safe against the shared
 * DEFAULT_TOPIC_MAP object).
 */
export function mergeTopicsDeterministic(map: TopicCoverageMap, newTopics: NewTopic[]): TopicCoverageMap {
  const topics = newTopics.filter(
    (t) => !isEmptyString(t.category) && !isEmptyString(t.subcategory) && !isEmptyString(t.slug),
  );

  const categories: Record<string, Record<string, string[]>> = {};
  for (const [category, subcategories] of Object.entries(map.categories)) {
    categories[category] = {};
    for (const [subcategory, slugs] of Object.entries(subcategories)) {
      categories[category][subcategory] = [...slugs];
    }
  }

  for (const topic of topics) {
    if (categories[topic.category] === undefined) categories[topic.category] = {};
    const bucket = categories[topic.category];
    if (bucket[topic.subcategory] === undefined) bucket[topic.subcategory] = [];
    if (!bucket[topic.subcategory].includes(topic.slug)) bucket[topic.subcategory].push(topic.slug);
  }

  return {
    version: map.version + 1,
    updatedAt: new Date().toISOString(),
    totalCards: map.totalCards + topics.length,
    recentTopicSlugs: topics.slice(-RECENT_SLUGS_CAP).map((t) => t.slug),
    categories,
  };
}

function mapHasSlug(map: TopicCoverageMap, category: string, subcategory: string, slug: string): boolean {
  return map.categories[category]?.[subcategory]?.includes(slug) ?? false;
}

/** Total slug count, walking categories -> subcategories -> slug arrays.
 * The validator only accepts string arrays as subcategory values, so there
 * are no summary-string entries to skip today; if a future pruning format
 * (plan §11) stores summaries as strings, validateTopicMap rejects those
 * maps before this count runs. */
function countMapSlugs(map: TopicCoverageMap): number {
  let total = 0;
  for (const subcategories of Object.values(map.categories)) {
    for (const slugs of Object.values(subcategories)) total += slugs.length;
  }
  return total;
}

/** Slack beyond `existingTotal + newTopics.length` before an AI-merged map is
 * considered runaway (invented slugs) and rejected in favor of the
 * deterministic merge. */
const MERGED_SLUG_SLACK = 10;

/**
 * Validate an AI-merged map against the map it came from:
 * version must be old+1, every previous (category, subcategory, slug) entry
 * must survive, and every new topic must be present under its target
 * category/subcategory. The total slug count may grow by at most
 * newTopics.length + MERGED_SLUG_SLACK (runaway-invention guard). Extra
 * unspecified fields/dimensions are tolerated.
 */
export function validateMergedMap(
  oldMap: TopicCoverageMap,
  candidate: unknown,
  newTopics: NewTopic[],
): boolean {
  const next = validateTopicMap(candidate);
  if (next === null) return false;
  if (next.version !== oldMap.version + 1) return false;

  for (const [category, subcategories] of Object.entries(oldMap.categories)) {
    const nextSubcategories = next.categories[category];
    if (nextSubcategories === undefined) return false;
    for (const [subcategory, slugs] of Object.entries(subcategories)) {
      const nextSlugs = nextSubcategories[subcategory];
      if (nextSlugs === undefined) return false;
      for (const slug of slugs) {
        if (!nextSlugs.includes(slug)) return false;
      }
    }
  }

  const topics = newTopics.filter(
    (t) => !isEmptyString(t.category) && !isEmptyString(t.subcategory) && !isEmptyString(t.slug),
  );
  for (const topic of topics) {
    if (!mapHasSlug(next, topic.category, topic.subcategory, topic.slug)) return false;
  }

  // Runaway guard: a valid merge adds (at most) the new topics. Anything
  // beyond newTopics.length + slack means the model invented extra slugs —
  // reject and let the caller fall back to the deterministic merge.
  const maxSlugs = countMapSlugs(oldMap) + newTopics.length + MERGED_SLUG_SLACK;
  if (countMapSlugs(next) > maxSlugs) return false;

  return true;
}

/**
 * Accept an AI-merged map if it validates; the deterministic fields
 * (totalCards, recentTopicSlugs, updatedAt) are always recomputed locally so
 * the AI cannot corrupt them. Returns null when the candidate is invalid —
 * caller then uses mergeTopicsDeterministic.
 */
export function finalizeMergedMap(
  candidate: unknown,
  oldMap: TopicCoverageMap,
  newTopics: NewTopic[],
): TopicCoverageMap | null {
  if (!validateMergedMap(oldMap, candidate, newTopics)) return null;
  const next = validateTopicMap(candidate)!;
  const topics = newTopics.filter((t) => !isEmptyString(t.slug));
  return {
    ...next,
    totalCards: oldMap.totalCards + topics.length,
    recentTopicSlugs: topics.slice(-RECENT_SLUGS_CAP).map((t) => t.slug),
    updatedAt: new Date().toISOString(),
  };
}
