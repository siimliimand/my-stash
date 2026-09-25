/**
 * Shared types for the My Stash Worker.
 *
 * NOTE: `wrangler types` also generates a global `Env` interface in
 * `worker-configuration.d.ts` from wrangler.jsonc bindings. The module-level
 * `Env` below is the one this codebase imports; keep the two in sync when
 * bindings change (CI runs `wrangler types --check` to catch stale output).
 */

/** Worker bindings + vars (mirrors wrangler.jsonc). */
export interface Env {
  /** D1 database holding generated cards and the generation log. */
  DB: D1Database;
  /** KV namespace holding the topic coverage map and API response cache. */
  KV: KVNamespace;
  /** OpenRouter model id (var). */
  OPENROUTER_MODEL: string;
  /** OpenRouter API base (var). */
  OPENROUTER_BASE_URL: string;
  /**
   * Allowed browser origin(s) for CORS (var): a single origin or a
   * comma-separated allowlist. Falls back to "*" when unset/empty.
   */
  CORS_ORIGIN: string;
  /** Secret. Missing key => generation routes return 503, reads stay up. */
  OPENROUTER_API_KEY?: string;
  /** Secret gating POST /api/generate. */
  ADMIN_SECRET?: string;
}

/**
 * Topic coverage map (plan §2.1) with one extension field:
 * `recentTopicSlugs` — the slugs of the most recently inserted cards
 * (capped at 50, refreshed every batch). Unlike relying on JSON key order,
 * this is a deterministic, explicit input for the near-dedup prompt.
 */
export interface TopicCoverageMap {
  version: number;
  updatedAt: string;
  totalCards: number;
  recentTopicSlugs: string[];
  categories: Record<string, Record<string, string[]>>;
}

/** A single title proposal from the title-generation AI call. */
export interface TitleCandidate {
  title: string;
  category: string;
  subcategory: string;
  topic_slug: string;
}

/** A fully expanded card body returned by the expansion AI call. */
export interface ExpandedCard {
  title: string;
  body: string;
  source: string;
  tags: string[];
}

/** One newly covered topic, merged into the coverage map after a batch. */
export interface NewTopic {
  category: string;
  subcategory: string;
  slug: string;
}

/** A row as written to the D1 `generated_cards` table. */
export interface GeneratedCardRow {
  id: string;
  title: string;
  body: string;
  source: string;
  /** JSON string array (column stores tags as TEXT). */
  tags: string;
  category: string;
  subcategory: string;
  topic_slug: string;
  title_hash: string;
  batch_date: string;
  created_at: string;
  word_count: number;
}

/** A card as returned by the public API (camelCase JSON). */
export interface ApiCard {
  id: string;
  title: string;
  body: string;
  source: string;
  tags: string[];
  category: string;
  subcategory: string;
  createdAt: string;
  batchDate: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface CardsResponse {
  cards: ApiCard[];
  pagination: Pagination;
}

export interface TodayResponse {
  cards: ApiCard[];
  /** batch_date the cards belong to (today, or the latest batch as fallback). */
  batchDate: string | null;
}

export interface StatsResponse {
  totalCards: number;
  totalBatches: number;
  lastBatchDate: string | null;
  lastBatchGenerated: number;
  categoryBreakdown: Record<string, number>;
  topicMapVersion: number;
}

/** Status recorded in the generation_log table. */
export type GenerationStatus = 'success' | 'partial' | 'failed';

/**
 * Result of one pipeline run. `status: 'skipped'` means nothing was attempted:
 * the D1 guard found a card-producing log row for today, or another concurrent
 * run holds the per-day lock (`reason: 'lock-held'`).
 */
export interface PipelineResult {
  status: GenerationStatus | 'skipped';
  batchDate: string;
  requested: number;
  generated: number;
  skippedDuplicates: number;
  durationMs: number;
  warnings: string[];
  skipped?: boolean;
  /** Why the run was skipped; currently 'lock-held' for the D1 run lock. */
  reason?: string;
}
