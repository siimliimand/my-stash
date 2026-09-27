import { z } from "zod";
import { Card } from "./types";

// Literal access — Next.js inlines NEXT_PUBLIC_* at build time.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const TIMEOUT_MS = 10_000;
// Page size for archive sync (the server clamps limit to 50 anyway).
const ARCHIVE_PAGE_LIMIT = 50;
// Safety ceiling: a misbehaving server must never loop the paginator forever.
const ARCHIVE_MAX_PAGES = 200;

export function isApiConfigured(): boolean {
  return API_BASE !== "";
}

const ApiCardSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().default(""),
  tags: z.array(z.string()),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  createdAt: z.string().min(1),
  batchDate: z.string().optional(),
});

// The wire shape of one AI card — also the lean shape persisted to
// localStorage by aiState (Card-only fields like favorite/reviewCount are
// rebuilt by rawToCard, user state is overlaid from aiOverrides).
export type RawAiCard = z.infer<typeof ApiCardSchema>;

export function rawToCard(api: RawAiCard): Card {
  return {
    id: api.id,
    title: api.title,
    body: api.body,
    source: api.source,
    tags: api.tags,
    createdAt: api.createdAt,
    updatedAt: api.createdAt,
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
    origin: "ai",
    category: api.category,
    subcategory: api.subcategory,
    batchDate: api.batchDate,
  };
}

function parseCardList(json: unknown): Card[] {
  const envelope = z.object({ cards: z.array(z.unknown()) }).safeParse(json);
  if (!envelope.success) return [];
  return envelope.data.cards.flatMap((entry) => {
    const result = ApiCardSchema.safeParse(entry);
    return result.success ? [rawToCard(result.data)] : [];
  });
}

// Never throws — any failure degrades to an empty list (localStorage-only mode).
export async function fetchTodayCards(): Promise<Card[]> {
  if (!API_BASE) return [];
  try {
    const res = await fetch(`${API_BASE}/api/cards/today`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseCardList(await res.json());
  } catch {
    return [];
  }
}

const CardsPageSchema = z.object({
  cards: z.array(z.unknown()),
  pagination: z.object({
    page: z.number().int().positive(),
    pages: z.number().int().nonnegative(),
  }),
});

/**
 * Fetch the server's card archive page by page — one small request at a
 * time, never the whole database in a single call. `onPage` fires after each
 * page so the caller can merge incrementally and the UI grows progressively.
 * Any failure (network, timeout, malformed page) stops the sync and keeps
 * whatever already landed; the next run picks the rest up via merges.
 */
export async function fetchArchiveCards(onPage: (cards: Card[]) => void): Promise<void> {
  if (!API_BASE) return;
  for (let page = 1; page <= ARCHIVE_MAX_PAGES; page++) {
    let cards: Card[];
    let lastPage: number;
    try {
      const res = await fetch(
        `${API_BASE}/api/cards?page=${page}&limit=${ARCHIVE_PAGE_LIMIT}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      );
      if (!res.ok) return;
      const parsed = CardsPageSchema.safeParse(await res.json());
      if (!parsed.success) return;
      cards = parsed.data.cards.flatMap((entry) => {
        const result = ApiCardSchema.safeParse(entry);
        return result.success ? [rawToCard(result.data)] : [];
      });
      lastPage = parsed.data.pagination.pages;
    } catch {
      return;
    }
    if (cards.length > 0) onPage(cards);
    if (page >= lastPage) return;
  }
}
