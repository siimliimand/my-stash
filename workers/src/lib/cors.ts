/** CORS + JSON response helpers shared by every route. */

import type { Env } from './types';

export type CorsHeaders = Record<string, string>;

/** Used only when the CORS_ORIGIN var is unset/empty (local dev convenience). */
export const CORS_ORIGIN_FALLBACK = '*';

/**
 * Build the CORS header set for a request. CORS_ORIGIN is a single origin or
 * a comma-separated allowlist:
 * - No Origin header on the request (curl, cron, server-to-server) -> the
 *   first allowlist entry (or "*" when the var is unset/empty).
 * - Origin exactly matches an allowlist entry -> THAT origin is echoed back,
 *   with `Vary: Origin` so caches key on it.
 * - Origin present but not on the allowlist -> no Access-Control-Allow-Origin
 *   at all; the browser blocks the response (correct).
 * A single configured origin keeps the previous behavior (exact echo); an
 * unset var keeps the "*" local-dev fallback for browsers too.
 */
export function withCors(
  env: Pick<Env, 'CORS_ORIGIN'>,
  request?: { headers: { get(name: string): string | null } },
): CorsHeaders {
  const raw = typeof env.CORS_ORIGIN === 'string' ? env.CORS_ORIGIN.trim() : '';
  const allowlist = raw.length > 0 ? raw.split(',').map((o) => o.trim()).filter((o) => o.length > 0) : [];

  const headers: CorsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  const origin = request?.headers.get('Origin') ?? null;
  if (origin === null || allowlist.length === 0) {
    // No Origin (non-browser client), or the var is unset/empty: fall back.
    headers['Access-Control-Allow-Origin'] = allowlist.length > 0 ? allowlist[0] : CORS_ORIGIN_FALLBACK;
    return headers;
  }
  if (!allowlist.includes(origin)) {
    // Origin present but not allowed: omit ACAO entirely (browser blocks).
    return headers;
  }
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Vary'] = 'Origin';
  return headers;
}

export interface JsonInit {
  status?: number;
  /** Cache-Control for this response; defaults to no-store (admin/generation). */
  cacheControl?: string;
}

/** JSON response with CORS headers, correct Content-Type and Cache-Control. */
export function jsonResponse(data: unknown, cors: CorsHeaders, init: JsonInit = {}): Response {
  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': init.cacheControl ?? 'no-store',
  };
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

/** 204 preflight response. */
export function optionsResponse(cors: CorsHeaders): Response {
  return new Response(null, { status: 204, headers: cors });
}
