/** Title hashing, normalization and AI-output validators (pure logic —
 * unit-tested in test/ with no Worker runtime required). */

import type { ExpandedCard, TitleCandidate } from '../lib/types';

/** Plan §2.2, exactly: lower, trim, collapse whitespace. Punctuation is
 * deliberately NOT stripped — the plan defines the function exhaustively. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** First 16 hex chars of SHA-256 (64-bit prefix) — the D1 dedup key. */
export async function sha256Prefix(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trimmed, de-duplicated (case-insensitive), max 3 tags — plan §6 format. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) continue;
    tags.push(trimmed);
    if (tags.length === 3) break;
  }
  return tags;
}

/** Word-count guard is 50–200 inclusive (plan §7: skip if <50 or >200). */
export const MIN_BODY_WORDS = 50;
export const MAX_BODY_WORDS = 200;

export function validateExpandedCard(raw: unknown): ExpandedCard | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.title) || !isNonEmptyString(record.body)) return null;
  if (!isNonEmptyString(record.source)) return null;

  const body = record.body.trim();
  const wordCount = countWords(body);
  if (wordCount < MIN_BODY_WORDS || wordCount > MAX_BODY_WORDS) return null;

  const tags = normalizeTags(record.tags);
  if (tags.length < 1) return null; // 1–3 tags required

  return { title: record.title.trim(), body, source: record.source.trim(), tags };
}

/**
 * Validate a list of expanded cards: drops invalid entries and de-duplicates
 * within the batch by normalized title (the AI sometimes echoes a title twice
 * across numbered inputs). Never throws.
 */
export function validateExpandedCards(parsed: unknown): ExpandedCard[] {
  if (!Array.isArray(parsed)) return [];
  const cards: ExpandedCard[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const card = validateExpandedCard(item);
    if (card === null) continue;
    const key = normalizeTitle(card.title);
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  return cards;
}

function extractTitleList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).titles)) {
    return (parsed as Record<string, unknown>).titles as unknown[];
  }
  return null;
}

/**
 * Validate + normalize a title-candidate list. Returns null when the payload
 * has no `titles` array at all (structural failure -> caller retries with a
 * stricter instruction), and an array (possibly empty) when the structure is
 * fine but some entries were invalid. De-duplicates within the batch by
 * normalized title.
 */
export function parseTitleList(parsed: unknown): TitleCandidate[] | null {
  const list = extractTitleList(parsed);
  if (list === null) return null;
  const candidates: TitleCandidate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      !isNonEmptyString(record.title) ||
      !isNonEmptyString(record.category) ||
      !isNonEmptyString(record.subcategory) ||
      !isNonEmptyString(record.topic_slug)
    ) {
      continue;
    }
    const candidate: TitleCandidate = {
      title: record.title.trim(),
      category: record.category.trim(),
      subcategory: record.subcategory.trim(),
      topic_slug: record.topic_slug.trim(),
    };
    const key = normalizeTitle(candidate.title);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/** Test/validation convenience: never returns null; garbage becomes []. */
export function validateTitleCandidates(parsed: unknown): TitleCandidate[] {
  return parseTitleList(parsed) ?? [];
}

/**
 * Validate the near-dedup filter's response: an `approved` array whose entries
 * may be full candidate objects or bare title strings. Returns the approved
 * titles as plain strings, or null when the structure is unusable.
 * (Subset-ness against the candidates we sent is enforced by the pipeline,
 * which is the only place that knows the candidate identity.)
 */
export function parseApprovedList(parsed: unknown): string[] | null {
  let list: unknown[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).approved)) {
    list = (parsed as Record<string, unknown>).approved as unknown[];
  } else {
    return null;
  }
  const titles: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) titles.push(item);
    } else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).title === 'string') {
      titles.push((item as Record<string, unknown>).title as string);
    }
  }
  return titles;
}

/**
 * Validate an expansion response. Returns null when there is no card array at
 * all (structural failure -> caller retries the batch once); otherwise the
 * list of valid cards (possibly empty).
 */
export function parseCardList(parsed: unknown): ExpandedCard[] | null {
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).cards)) {
    list = (parsed as Record<string, unknown>).cards;
  } else {
    return null;
  }
  return validateExpandedCards(list);
}
