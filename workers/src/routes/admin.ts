/** POST /api/generate — secret-gated manual trigger for the pipeline. */

import { alreadyRanToday } from '../lib/db';
import { jsonResponse, type CorsHeaders } from '../lib/cors';
import { runGeneration } from '../generation/pipeline';
import type { Env } from '../lib/types';

/**
 * Constant-ish string comparison for the admin bearer secret: compares
 * lengths, then XOR-walks every byte so early exits do not leak where the
 * first difference is. (timingSafeEqual is not available in Workers; this is
 * the pure-JS equivalent recommended for non-crypto-grade secrets.)
 */
export function secureCompare(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export async function handleGenerate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: CorsHeaders,
): Promise<Response> {
  // 1. Auth — required, exact bearer match.
  if (env.ADMIN_SECRET === undefined || env.ADMIN_SECRET.length === 0) {
    // Operator misconfiguration: no way to authenticate anyone.
    return jsonResponse({ error: 'admin secret not configured' }, cors, { status: 503 });
  }
  const authorization = request.headers.get('Authorization') ?? '';
  if (!secureCompare(authorization, `Bearer ${env.ADMIN_SECRET}`)) {
    return jsonResponse({ error: 'unauthorized' }, cors, { status: 401 });
  }

  // 2. Generation must be configured (read endpoints keep working without it).
  if (env.OPENROUTER_API_KEY === undefined || env.OPENROUTER_API_KEY.length === 0) {
    return jsonResponse({ error: 'generation not configured' }, cors, { status: 503 });
  }

  // 3. Optional body: { "requested": n } clamped to 1–50, default 50.
  let requested = 50;
  const rawBody = await request.text();
  if (rawBody.trim().length > 0) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'invalid json body' }, cors, { status: 400 });
    }
    if (typeof parsedBody === 'object' && parsedBody !== null && 'requested' in parsedBody) {
      const value = (parsedBody as Record<string, unknown>).requested;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return jsonResponse({ error: 'invalid requested value' }, cors, { status: 400 });
      }
      requested = Math.min(50, Math.max(1, Math.floor(value)));
    }
  }

  // 4. Cheap pre-check of the pipeline guard (authoritative check still runs
  // inside the pipeline, covering the race between check and start).
  const today = new Date().toISOString().slice(0, 10);
  let alreadyDone = false;
  try {
    alreadyDone = await alreadyRanToday(env.DB, today);
  } catch {
    // D1 unavailable: fall through — the pipeline guard will decide.
  }
  if (alreadyDone) {
    return jsonResponse({ status: 'already_completed', batchDate: today }, cors);
  }

  // 5. Fire and forget — respond immediately (plan §7).
  ctx.waitUntil(
    runGeneration(env, ctx, { requested }).catch((err: unknown) => {
      console.error('[generate] pipeline failed:', err instanceof Error ? err.message : err);
    }),
  );
  return jsonResponse({ status: 'started', batchDate: today }, cors, { status: 202 });
}
