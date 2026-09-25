/** GET /api/cards and GET /api/cards/today (plan §7). */

import { queryCards, queryTodayCards, type CardQuery } from '../lib/db';
import { jsonResponse, type CorsHeaders } from '../lib/cors';
import { getJson, putJson } from '../lib/kv';
import { sha256Prefix } from '../generation/dedup';
import type { CardsResponse, Env, TodayResponse } from '../lib/types';

const CARDS_CACHE_TTL = 3600; // 1 hour
const TODAY_CACHE_KEY = 'api-cache:today';
/** Server-side KV TTL for /today. The pipeline invalidates this key after
 * each batch, so a long TTL here is safe. */
const TODAY_CACHE_TTL = 21600; // 6 hours
/** Browser Cache-Control for /today. Short max-age + stale-while-revalidate:
 * a 6 h BROWSER cache served stale cards all day after a batch landed (the
 * browser never revalidates), so the browser TTL is the short one now. */
const TODAY_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=21000';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  // Note: Number(null) is 0, not NaN — absent/blank params must short-circuit
  // to the fallback before numeric coercion.
  if (value === null || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** Parse + clamp query params. Invalid/blank values fall back to defaults;
 * `date` must look like YYYY-MM-DD or it is ignored (never bound as undefined
 * — D1 rejects undefined bind values). */
export function parseCardQuery(url: URL): CardQuery {
  const category = rawParam(url.searchParams.get('category'));
  const tag = rawParam(url.searchParams.get('tag'));
  const rawDate = rawParam(url.searchParams.get('date'));
  return {
    page: clampInt(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER, DEFAULT_PAGE),
    limit: clampInt(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT),
    category,
    tag,
    date: rawDate !== undefined && DATE_PATTERN.test(rawDate) ? rawDate : undefined,
  };
}

function rawParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Stable KV cache key for a (page, limit, category, tag, date) combination.
 * Hashed so arbitrary category/tag strings cannot collide with the key
 * namespace; same params always produce the same key. */
export async function cardsCacheKey(query: CardQuery): Promise<string> {
  const canonical = JSON.stringify([query.page, query.limit, query.category ?? '', query.tag ?? '', query.date ?? '']);
  return `api-cache:cards:${await sha256Prefix(canonical)}`;
}

function validateCardsPayload(value: unknown): CardsResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cards)) return null;
  const pagination = record.pagination;
  if (typeof pagination !== 'object' || pagination === null) return null;
  const p = pagination as Record<string, unknown>;
  if (typeof p.page !== 'number' || typeof p.limit !== 'number' || typeof p.total !== 'number' || typeof p.pages !== 'number') {
    return null;
  }
  return value as CardsResponse;
}

function validateTodayPayload(value: unknown): TodayResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cards)) return null;
  if (record.batchDate !== null && typeof record.batchDate !== 'string') return null;
  return value as TodayResponse;
}

export async function handleCards(request: Request, env: Env, cors: CorsHeaders): Promise<Response> {
  const query = parseCardQuery(new URL(request.url));
  const cacheControl = `public, max-age=${CARDS_CACHE_TTL}`;

  const cacheKey = await cardsCacheKey(query);
  const cached = await getJson(env.KV, cacheKey, validateCardsPayload);
  if (cached !== null) return jsonResponse(cached, cors, { cacheControl });

  const payload = await queryCards(env.DB, query);
  // Skip caching empty results so the first batch after a deploy is served
  // from D1 (fresh) instead of a stale empty payload.
  if (payload.pagination.total > 0) {
    const stored = await putJson(env.KV, cacheKey, payload, CARDS_CACHE_TTL);
    if (!stored) {
      // Cache write failures are non-fatal: the response is still served.
    }
  }
  return jsonResponse(payload, cors, { cacheControl });
}

export async function handleToday(_request: Request, env: Env, cors: CorsHeaders): Promise<Response> {
  const cached = await getJson(env.KV, TODAY_CACHE_KEY, validateTodayPayload);
  if (cached !== null) return jsonResponse(cached, cors, { cacheControl: TODAY_CACHE_CONTROL });

  const payload = await queryTodayCards(env.DB, new Date().toISOString().slice(0, 10));
  await putJson(env.KV, TODAY_CACHE_KEY, payload, TODAY_CACHE_TTL);
  return jsonResponse(payload, cors, { cacheControl: TODAY_CACHE_CONTROL });
}
