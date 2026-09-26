// Admin generation triggers, both secret-gated:
//   POST /api/generate — QUEUES a run for the */15 cron poller.
//   POST /api/run-sync — runs the pipeline INLINE in the request (see its
//                        doc comment for why that exists and is safe).
//
// /api/generate queues rather than starts: waitUntil promises on an HTTP
// fetch event are killed ~30 s after the response on the real runtime (the
// pipeline needs ~77 s), so the every-15-minutes cron poller picks the
// request up and executes it inside a cron invocation's 15-minute budget.
// See README "Deviations" #17 and #18.

import { alreadyRanToday, queueRunRequest } from '../lib/db';
import { runGeneration } from '../generation/pipeline';
import { DEFAULT_DAILY_REQUESTED } from '../generation/categories';
import { jsonResponse, type CorsHeaders } from '../lib/cors';
import type { Env, PipelineResult } from '../lib/types';

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

/**
 * Shared admin-endpoint guard, in handleGenerate's original order: 503 when
 * ADMIN_SECRET is unset (operator misconfiguration — no way to authenticate
 * anyone), 401 on a missing/non-matching bearer, then 503 when generation is
 * not configured (read endpoints keep working without it). Returns the error
 * response, or null to proceed.
 */
export function guardAdminAccess(request: Request, env: Env, cors: CorsHeaders): Response | null {
  if (env.ADMIN_SECRET === undefined || env.ADMIN_SECRET.length === 0) {
    return jsonResponse({ error: 'admin secret not configured' }, cors, { status: 503 });
  }
  const authorization = request.headers.get('Authorization') ?? '';
  if (!secureCompare(authorization, `Bearer ${env.ADMIN_SECRET}`)) {
    return jsonResponse({ error: 'unauthorized' }, cors, { status: 401 });
  }
  if (env.OPENROUTER_API_KEY === undefined || env.OPENROUTER_API_KEY.length === 0) {
    return jsonResponse({ error: 'generation not configured' }, cors, { status: 503 });
  }
  return null;
}

/**
 * Shared body parse for both admin endpoints: optional `{ "requested": n }`
 * clamped to 1–50, defaulting to the daily target of 2 cards per canonical
 * category (16). Invalid JSON, or a `requested` that is not a
 * number, returns the 400 response; otherwise the parsed value.
 */
export async function parseRequested(request: Request, cors: CorsHeaders): Promise<{ requested: number } | Response> {
  let requested = DEFAULT_DAILY_REQUESTED;
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
  return { requested };
}

/**
 * Shared cheap pre-check of the pipeline guard (authoritative check still
 * runs inside the pipeline, covering the race between check and start).
 * Returns the 200 short-circuit response when today already produced cards,
 * else null. A D1 outage falls through — the pipeline guard will decide.
 */
export async function alreadyCompletedResponse(env: Env, cors: CorsHeaders): Promise<Response | null> {
  const today = new Date().toISOString().slice(0, 10);
  let alreadyDone = false;
  try {
    alreadyDone = await alreadyRanToday(env.DB, today);
  } catch {
    // D1 unavailable: fall through — the pipeline guard will decide.
  }
  if (!alreadyDone) return null;
  return jsonResponse({ status: 'already_completed', batchDate: today }, cors);
}

export async function handleGenerate(request: Request, env: Env, cors: CorsHeaders): Promise<Response> {
  const guard = guardAdminAccess(request, env, cors);
  if (guard !== null) return guard;

  const body = await parseRequested(request, cors);
  if (body instanceof Response) return body;

  const alreadyDone = await alreadyCompletedResponse(env, cors);
  if (alreadyDone !== null) return alreadyDone;

  // Queue and return immediately (plan §7's "returns immediately", via a
  // durable row instead of an HTTP waitUntil that dies at ~30 s). The */15
  // cron poller consumes it and runs the pipeline inside a cron invocation's
  // 15-minute budget. The pipeline re-checks the guard authoritatively.
  const today = new Date().toISOString().slice(0, 10);
  await queueRunRequest(env.DB, today, body.requested);
  return jsonResponse({ status: 'queued', batchDate: today }, cors, { status: 202 });
}

/**
 * POST /api/run-sync — synchronous generation trigger: AWAITS the pipeline
 * inside the HTTP request instead of queueing it for a cron.
 *
 * WHY this exists: cron events are not being delivered for this worker —
 * both triggers are registered correctly yet zero `scheduled` invocations
 * arrive (an every-minute trigger sat for 10+ minutes of `wrangler tail`
 * with no scheduled event while HTTP requests kept flowing), so neither the
 * 05:00 batch nor #17's 15-minute poller can execute anything. That is a platform
 * issue under investigation (README "Deviations" #18); until it is resolved,
 * this endpoint is the working execution path.
 *
 * WHY inline is safe here when #17's `ctx.waitUntil` was not: the ~30 s kill
 * applies only to promises still running AFTER the response has been sent —
 * an in-flight awaited request keeps the isolate alive with no such ceiling.
 * The pipeline is I/O-bound (~90 s wall, ~0 ms CPU), comfortably under the
 * free tier's 10 ms CPU cap. Concurrency needs no queue: the pipeline's D1
 * run lock (one 'running' row per day, deviation #13) plus the
 * `alreadyRanToday` idempotency guard make concurrent or duplicate
 * invocations no-ops — the loser resolves with `status: 'skipped'`, mapped
 * to the same `already_completed` short-circuit below.
 */
export async function handleRunSync(
  request: Request,
  env: Env,
  cors: CorsHeaders,
  ctx: ExecutionContext,
): Promise<Response> {
  const guard = guardAdminAccess(request, env, cors);
  if (guard !== null) return guard;

  const body = await parseRequested(request, cors);
  if (body instanceof Response) return body;

  // Same cheap pre-check as /api/generate; the pipeline re-checks
  // authoritatively. Skips the ~90 s run when the day is already done.
  const alreadyDone = await alreadyCompletedResponse(env, cors);
  if (alreadyDone !== null) return alreadyDone;

  let result: PipelineResult;
  try {
    // No waitUntil, no queue: awaiting keeps the request (and the isolate)
    // open for the full ~90 s the pipeline needs.
    result = await runGeneration(env, ctx, { requested: body.requested });
  } catch (err) {
    // 502 (not 500): distinguishes a pipeline failure from a worker-routing
    // failure. The pipeline finalizes its generation_log row as 'failed'
    // before rethrowing, so the attempt is already on record.
    return jsonResponse(
      { error: 'generation_failed', detail: err instanceof Error ? err.message : String(err) },
      cors,
      { status: 502 },
    );
  }
  if (result.status === 'skipped') {
    // Nothing was attempted: the day completed between our pre-check and the
    // pipeline's own guard, or a concurrent run holds the D1 run lock.
    return jsonResponse({ status: 'already_completed', batchDate: result.batchDate }, cors);
  }
  if (result.status === 'failed') {
    // The pipeline converts hard AI failures into a 'failed' RESULT (it
    // catches, logs, and resolves) — so without this branch a dead run would
    // report 200. 502 tells the operator to retry; the failed day allows it.
    const detail = result.warnings.length > 0 ? result.warnings.join('; ') : 'run logged as failed in generation_log';
    return jsonResponse({ error: 'generation_failed', detail }, cors, { status: 502 });
  }
  // result's own status ('success' | 'partial') and batchDate are spread
  // first so this endpoint's 'completed' marker survives the spread.
  return jsonResponse({ ...result, status: 'completed', batchDate: result.batchDate }, cors);
}
