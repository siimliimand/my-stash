/** GET /api/stats (plan §7). Cheap aggregate queries — no KV response cache,
 * just a short browser Cache-Control. */

import { lastBatchGenerated, queryStats } from '../lib/db';
import { jsonResponse, type CorsHeaders } from '../lib/cors';
import { getJson } from '../lib/kv';
import { TOPIC_MAP_KEY, validateTopicMap } from '../generation/topic-map';
import type { Env } from '../lib/types';

const STATS_CACHE_CONTROL = 'max-age=300';

export async function handleStats(_request: Request, env: Env, cors: CorsHeaders): Promise<Response> {
  const [aggregates, topicMap] = await Promise.all([
    queryStats(env.DB),
    getJson(env.KV, TOPIC_MAP_KEY, validateTopicMap),
  ]);

  const lastGenerated =
    aggregates.lastBatchDate !== null ? await lastBatchGenerated(env.DB, aggregates.lastBatchDate) : 0;

  return jsonResponse(
    {
      totalCards: aggregates.totalCards,
      totalBatches: aggregates.totalBatches,
      lastBatchDate: aggregates.lastBatchDate,
      lastBatchGenerated: lastGenerated,
      categoryBreakdown: aggregates.categoryBreakdown,
      topicMapVersion: topicMap?.version ?? 0,
      // Presence only — never the value. A `false` here is the smoking gun for
      // the 2026-09-27 outage class: a deploy that did not carry the secret
      // onto the active version, so every generation attempt dies instantly
      // with "OPENROUTER_API_KEY is not set on the Worker" while reads keep
      // working. Check this right after every `wrangler deploy`.
      hasOpenrouterKey: env.OPENROUTER_API_KEY !== undefined && env.OPENROUTER_API_KEY.length > 0,
    },
    cors,
    { cacheControl: STATS_CACHE_CONTROL },
  );
}
