/** My Stash API — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /api/cards        paginated card list
 *   GET  /api/cards/today  today's batch (falls back to latest batch)
 *   GET  /api/stats        aggregate stats
 *   POST /api/generate     admin secret-gated generation trigger
 *   cron 0 5 * * *         daily generation (05:00 UTC)
 *
 * When OPENROUTER_API_KEY is unset the read endpoints keep working — only
 * generation returns 503 (PM override of plan §13; documented in README).
 */

import { handleCards, handleToday } from './routes/cards';
import { handleStats } from './routes/stats';
import { handleGenerate } from './routes/admin';
import { jsonResponse, optionsResponse, withCors } from './lib/cors';
import { runGeneration } from './generation/pipeline';
import type { Env } from './lib/types';

const KNOWN_PATHS = new Set(['/api/cards', '/api/cards/today', '/api/stats', '/api/generate']);

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
        return await handleGenerate(request, env, ctx, cors);
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
      ctx.waitUntil(
        runGeneration(env, ctx, { requested: 50 })
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
