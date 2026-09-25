import { z } from "zod";
import { Card } from "./types";

const STORAGE_KEY = "my-stash-ai-state";
const WRITE_DELAY_MS = 400;

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
