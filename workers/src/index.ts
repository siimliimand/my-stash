/** My Stash API — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /api/cards        paginated card list
 *   GET  /api/cards/today  today's batch (falls back to latest batch)
 *   GET  /api/stats        aggregate stats
 *   POST /api/generate     admin secret-gated generation trigger (QUEUES a
 *                          run for the poller; the synchronous alternative
 *                          is /api/run-sync)
 *   POST /api/run-sync     admin trigger that AWAITS the pipeline inline —
 *                          cron events are currently not delivered for this
 *                          worker (README "Deviations" #18), so this is the
 *                          working execution path
 *
 * Crons:
 *   0 5 * * *      daily generation batch (05:00 UTC)
 *   * /15 * * * *  poller that executes queued manual runs (POST
 *                  /api/generate) inside a cron invocation's 15-minute
 *                  budget — waitUntil on an HTTP fetch event is killed ~30 s
 *                  after the response, too short for the ~77 s pipeline.
 *                  (Currently dormant: see /api/run-sync above.)
 *
 * When OPENROUTER_API_KEY is unset the read endpoints keep working — only
 * generation returns 503 (PM override of plan §13; documented in README).
 */

import { handleCards, handleToday } from './routes/cards';
import { handleStats } from './routes/stats';
import { handleGenerate, handleRunSync } from './routes/admin';
import { DEFAULT_DAILY_REQUESTED } from './generation/categories';
import { jsonResponse, optionsResponse, withCors } from './lib/cors';
import { consumeRunRequest } from './lib/db';
import { runGeneration } from './generation/pipeline';
import type { Env } from './lib/types';

const KNOWN_PATHS = new Set(['/api/cards', '/api/cards/today', '/api/stats', '/api/generate', '/api/run-sync']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The request is passed so a CORS_ORIGIN allowlist can echo the matching
    // origin (see lib/cors.ts).
    const cors = withCors(env, request);
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (request.method === 'OPTIONS') return optionsResponse(cors);

    try {
      if (path === '/api/cards' && request.method === 'GET') return await handleCards(request, env, cors);
      if (path === '/api/cards/today' && request.method === 'GET') return await handleToday(request, env, cors);
      if (path === '/api/stats' && request.method === 'GET') return await handleStats(request, env, cors);
      if (path === '/api/generate' && request.method === 'POST') {
        return await handleGenerate(request, env, cors);
      }
      if (path === '/api/run-sync' && request.method === 'POST') {
        return await handleRunSync(request, env, cors, ctx);
      }

      if (KNOWN_PATHS.has(path)) {
        return jsonResponse({ error: 'method_not_allowed' }, cors, { status: 405 });
      }
      return jsonResponse({ error: 'not_found' }, cors, { status: 404 });
    } catch (err) {
      console.error('[worker] unhandled error:', err instanceof Error ? err.stack ?? err.message : err);
      return jsonResponse({ error: 'internal_error' }, cors, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[cron] fired ${controller.cron} at ${new Date(controller.scheduledTime).toISOString()}`);
    try {
      const today = new Date(controller.scheduledTime).toISOString().slice(0, 10);
      const isDailyCron = controller.cron === '0 5 * * *';

      // Claim a queued manual run BEFORE deciding (claim-before-run): the row
      // is deleted up front so it can never dangle — if the run then fails,
      // the pipeline's generation_log row records the attempt. Two concurrent
      // consumers cannot take the same row (the DELETE's changes = 0 loses the
      // race), and the pipeline's D1 lock backstops the rest.
      let manual: { requested: number } | null = null;
      try {
        manual = await consumeRunRequest(env.DB, today);
      } catch (err) {
        // D1 unavailable: the daily cron still attempts its run (the 05:00
        // behavior is unchanged); the poller must NOT fire AI calls on a
        // failed lookup — a queued request simply waits for the next fire.
        console.error('[cron] run_requests lookup failed:', err instanceof Error ? err.message : err);
        if (!isDailyCron) return;
      }

      // */15 poller with nothing queued: no-op, no AI calls.
      if (!isDailyCron && manual === null) return;
      // Daily default: 2 cards per canonical category (16) — README
      // "Deviations" #20; a queued manual run keeps its own override.
      const requested = manual?.requested ?? DEFAULT_DAILY_REQUESTED;

      ctx.waitUntil(
        runGeneration(env, ctx, { requested })
          .then((result) => console.log('[cron] generation result:', JSON.stringify(result)))
          .catch((err: unknown) => {
            console.error('[cron] generation failed:', err instanceof Error ? err.message : err);
          }),
      );
    } catch (err) {
      // The scheduled handler must never throw.
      console.error('[cron] failed to start generation:', err instanceof Error ? err.message : err);
    }
  },
} satisfies ExportedHandler<Env>;
