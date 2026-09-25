import { z } from "zod";
import { Card } from "./types";

// Literal access — Next.js inlines NEXT_PUBLIC_* at build time.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const TIMEOUT_MS = 10_000;

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

type ApiCard = z.infer<typeof ApiCardSchema>;

function toCard(api: ApiCard): Card {
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

// Never throws — any failure degrades to an empty list (localStorage-only mode).
export async function fetchTodayCards(): Promise<Card[]> {
  if (!API_BASE) return [];
  try {
    const res = await fetch(`${API_BASE}/api/cards/today`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    const envelope = z.object({ cards: z.array(z.unknown()) }).safeParse(json);
    if (!envelope.success) return [];
    return envelope.data.cards.flatMap((entry) => {
      const result = ApiCardSchema.safeParse(entry);
      return result.success ? [toCard(result.data)] : [];
    });
  } catch {
    return [];
  }
}
