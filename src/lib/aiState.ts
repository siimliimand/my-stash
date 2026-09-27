import { z } from "zod";
import { Card } from "./types";
import { RawAiCard, rawToCard } from "./api";

const STORAGE_KEY = "my-stash-ai-state";
const WRITE_DELAY_MS = 400;

// Accumulated AI-card archive — every card the backend ever delivered, so
// past daily batches stay in the deck. The wire/lean shape is persisted and
// rebuilt into full Cards on read; user state lives in the overrides above.
const CARDS_STORAGE_KEY = "my-stash-ai-cards";
const CARDS_SCHEMA_VERSION = 1;
let cardWriteTimer: ReturnType<typeof setTimeout> | null = null;

const PersistedAiCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  createdAt: z.string(),
  batchDate: z.string().optional(),
}) satisfies z.ZodType<RawAiCard>;

const AiCardsFileSchema = z.object({
  schemaVersion: z.literal(CARDS_SCHEMA_VERSION),
  cards: z.array(PersistedAiCardSchema),
});

/**
 * null = nothing (or nothing valid) persisted — the caller should treat the
 * archive as empty and backfill it from the API, page by page. Corrupt data
 * also maps to null so the backfill self-heals it.
 */
export function readPersistedAiCards(): Card[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CARDS_STORAGE_KEY);
    if (!raw) return null;
    const result = AiCardsFileSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn("AI card archive validation failed:", result.error.flatten());
      return null;
    }
    if (result.data.cards.length === 0) return null;
    return result.data.cards.map(rawToCard);
  } catch (err) {
    console.error("Failed to read AI card archive from localStorage:", err);
    return null;
  }
}

export function writePersistedAiCards(cards: Card[]): void {
  if (typeof window === "undefined") return;
  if (cardWriteTimer) clearTimeout(cardWriteTimer);
  cardWriteTimer = setTimeout(() => {
    try {
      const payload = {
        schemaVersion: CARDS_SCHEMA_VERSION,
        cards: cards.map(toPersisted),
      };
      localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to write AI card archive to localStorage:", err);
    }
  }, WRITE_DELAY_MS);
}

function toPersisted(c: Card): RawAiCard {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    source: c.source,
    tags: c.tags,
    category: c.category,
    subcategory: c.subcategory,
    createdAt: c.createdAt,
    batchDate: c.batchDate,
  };
}

const ReviewOverrideSchema = z.object({
  lastReviewedAt: z.string().datetime(),
  reviewCount: z.number().int().nonnegative(),
});

const EditOverrideSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const AiOverridesSchema = z.object({
  deleted: z.array(z.string()).default([]),
  favorites: z.array(z.string()).default([]),
  reviews: z.record(z.string(), ReviewOverrideSchema).default({}),
  edits: z.record(z.string(), EditOverrideSchema).default({}),
});

export type AiCardOverrides = z.infer<typeof AiOverridesSchema>;

const EMPTY_AI_OVERRIDES: AiCardOverrides = {
  deleted: [],
  favorites: [],
  reviews: {},
  edits: {},
};

// Shared constant so "nothing stored" keeps a stable identity (skips redundant writes).
export { EMPTY_AI_OVERRIDES };

let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function readAiOverrides(): AiCardOverrides {
  if (typeof window === "undefined") return EMPTY_AI_OVERRIDES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_AI_OVERRIDES;
    const result = AiOverridesSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn("AI state validation failed:", result.error.flatten());
      return EMPTY_AI_OVERRIDES;
    }
    return result.data;
  } catch (err) {
    console.error("Failed to read AI overrides from localStorage:", err);
    return EMPTY_AI_OVERRIDES;
  }
}

export function writeAiOverrides(overrides: AiCardOverrides): void {
  if (typeof window === "undefined") return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch (err) {
      console.error("Failed to write AI overrides to localStorage:", err);
    }
  }, WRITE_DELAY_MS);
}

// Pure: drops deleted ids and overlays favorite/review/edit state onto API cards.
export function applyAiOverrides(aiCards: Card[], overrides: AiCardOverrides): Card[] {
  const deleted = new Set(overrides.deleted);
  const favorites = new Set(overrides.favorites);
  return aiCards
    .filter((c) => !deleted.has(c.id))
    .map((c) => {
      const review = overrides.reviews[c.id];
      const edit = overrides.edits[c.id];
      if (!review && !edit && !favorites.has(c.id)) return c;
      return {
        ...c,
        favorite: favorites.has(c.id),
        lastReviewedAt: review?.lastReviewedAt ?? c.lastReviewedAt,
        reviewCount: review?.reviewCount ?? c.reviewCount,
        title: edit?.title ?? c.title,
        body: edit?.body ?? c.body,
        source: edit?.source ?? c.source,
        tags: edit?.tags ?? c.tags,
      };
    });
}
