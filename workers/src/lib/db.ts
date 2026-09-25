/** Thin D1 helpers used by the routes and the generation pipeline.
 *
 * D1 constraints respected here:
 * - Hard limit of 100 bound parameters per statement -> IN-chunks of 90.
 * - `undefined` bind values throw D1_ERROR -> callers always bind concrete
 *   strings/numbers built from validated query params.
 * - `db.batch()` is transactional; a failed statement rolls back the whole
 *   chunk, so insert failures are reported per-chunk and never abort a run.
 */

import type { ApiCard, CardsResponse, GeneratedCardRow } from './types';

/** Stay safely under D1's 100-parameter per-statement hard limit. */
const IN_CHUNK_SIZE = 90;
/** Statements per db.batch() call. */
const BATCH_CHUNK_SIZE = 50;

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Look up which of the given title hashes already exist in D1. */
export async function getExistingHashes(db: D1Database, hashes: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const chunk of chunkArray(hashes, IN_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db
      .prepare(`SELECT title_hash FROM generated_cards WHERE title_hash IN (${placeholders})`)
      .bind(...chunk)
      .all<{ title_hash: string }>();
    for (const row of result.results ?? []) existing.add(row.title_hash);
  }
  return existing;
}

const INSERT_SQL = `INSERT INTO generated_cards
  (id, title, body, source, tags, category, subcategory, topic_slug, title_hash, batch_date, created_at, word_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(title_hash) DO NOTHING`;

/**
 * Insert card rows in transactional batch chunks.
 * Returns one entry per input row: the value of `meta.changes` for its
 * statement (1 = inserted, 0 = conflict or failed chunk). Callers sum the
 * array for the inserted count and zip it with rows to build the topic-map
 * update from *actually inserted* cards only.
 */
export async function insertCards(db: D1Database, rows: GeneratedCardRow[]): Promise<number[]> {
  const changes = new Array<number>(rows.length).fill(0);
  const chunks = chunkArray(rows, BATCH_CHUNK_SIZE);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const statements = chunk.map((row) =>
      db
        .prepare(INSERT_SQL)
        .bind(
          row.id,
          row.title,
          row.body,
          row.source,
          row.tags,
          row.category,
          row.subcategory,
          row.topic_slug,
          row.title_hash,
          row.batch_date,
          row.created_at,
          row.word_count,
        ),
    );
    try {
      const results = await db.batch(statements);
      for (let i = 0; i < results.length; i++) {
        changes[c * BATCH_CHUNK_SIZE + i] = results[i]?.meta?.changes ?? 0;
      }
    } catch {
      // Transactional chunk rolled back; those rows report 0 changes and the
      // pipeline continues with the next chunk (plan §13).
    }
  }
  return changes;
}

export interface CardQuery {
  page: number;
  limit: number;
  category?: string;
  tag?: string;
  date?: string;
}

interface RawCardRow {
  id: string;
  title: string;
  body: string;
  source: string;
  tags: string;
  category: string;
  subcategory: string;
  created_at: string;
  batch_date: string;
}

function toApiCard(row: RawCardRow): ApiCard {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    tags,
    category: row.category,
    subcategory: row.subcategory,
    createdAt: row.created_at,
    batchDate: row.batch_date,
  };
}

function buildWhere(query: CardQuery): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.category !== undefined) {
    clauses.push('category = ?');
    params.push(query.category);
  }
  if (query.tag !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(generated_cards.tags) WHERE json_each.value = ?)');
    params.push(query.tag);
  }
  if (query.date !== undefined) {
    clauses.push('batch_date = ?');
    params.push(query.date);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Paginated, filtered card list — response shape per plan §7. */
export async function queryCards(db: D1Database, query: CardQuery): Promise<CardsResponse> {
  const { where, params } = buildWhere(query);
  const offset = (query.page - 1) * query.limit;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM generated_cards ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;

  const listResult = await db
    .prepare(
      `SELECT id, title, body, source, tags, category, subcategory, created_at, batch_date
       FROM generated_cards ${where}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, query.limit, offset)
    .all<RawCardRow>();

  const pages = Math.max(1, Math.ceil(total / query.limit));
  return {
    cards: (listResult.results ?? []).map(toApiCard),
    pagination: { page: query.page, limit: query.limit, total, pages },
  };
}

/**
 * Cards for today's batch. Degrades gracefully: when today has no cards yet
 * (e.g. before the first cron fired), returns the most recent batch that has
 * cards instead of an empty list (documented in README).
 */
export async function queryTodayCards(db: D1Database, today: string): Promise<{ cards: ApiCard[]; batchDate: string | null }> {
  // rowid tiebreak: batch-internal page/card boundaries stay stable when a
  // batch shares one created_at timestamp.
  const selectForDate = db.prepare(
    `SELECT id, title, body, source, tags, category, subcategory, created_at, batch_date
     FROM generated_cards WHERE batch_date = ? ORDER BY created_at ASC, rowid ASC`,
  );

  const todays = await selectForDate.bind(today).all<RawCardRow>();
  if ((todays.results?.length ?? 0) > 0) {
    return { cards: todays.results!.map(toApiCard), batchDate: today };
  }

  const latest = await db
    .prepare('SELECT batch_date FROM generated_cards ORDER BY batch_date DESC LIMIT 1')
    .first<{ batch_date: string }>();
  if (!latest) return { cards: [], batchDate: null };

  const fallback = await selectForDate.bind(latest.batch_date).all<RawCardRow>();
  return { cards: (fallback.results ?? []).map(toApiCard), batchDate: latest.batch_date };
}

export interface StatsAggregates {
  totalCards: number;
  totalBatches: number;
  lastBatchDate: string | null;
  categoryBreakdown: Record<string, number>;
}

/** Aggregate stats for GET /api/stats (cheap — no KV response cache needed). */
export async function queryStats(db: D1Database): Promise<StatsAggregates> {
  const [totals, byCategory] = await db.batch([
    db.prepare(
      'SELECT COUNT(*) AS total, COUNT(DISTINCT batch_date) AS batches, MAX(batch_date) AS last_date FROM generated_cards',
    ),
    db.prepare('SELECT category, COUNT(*) AS count FROM generated_cards GROUP BY category ORDER BY count DESC'),
  ]);

  const totalsRow = totals?.results?.[0] as { total: number; batches: number; last_date: string | null } | undefined;
  const categoryBreakdown: Record<string, number> = {};
  for (const row of (byCategory?.results ?? []) as Array<{ category: string; count: number }>) {
    categoryBreakdown[row.category] = row.count;
  }

  return {
    totalCards: totalsRow?.total ?? 0,
    totalBatches: totalsRow?.batches ?? 0,
    lastBatchDate: totalsRow?.last_date ?? null,
    categoryBreakdown,
  };
}

/** `generated` count from the latest success/partial log row for a batch.
 * The status filter explicitly excludes 'running' (an in-flight run must not
 * be reported as the last batch's output) and 'failed' (no cards). */
export async function lastBatchGenerated(db: D1Database, batchDate: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT generated FROM generation_log
       WHERE batch_date = ? AND status IN ('success', 'partial')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(batchDate)
    .first<{ generated: number }>();
  return row?.generated ?? 0;
}

/**
 * Idempotency guard: has `today` already produced cards? A 'success' row, or
 * a 'partial' row WITH cards, means the day is done (no double-generate). A
 * 'failed' row and a 0-card 'partial' row both allow a retry — a day that
 * produced nothing must never be permanently un-retryable. D1 is strongly
 * consistent — this is authoritative; KV is not.
 */
export async function alreadyRanToday(db: D1Database, today: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM generation_log
       WHERE batch_date = ?
         AND (status = 'success' OR (status = 'partial' AND generated > 0))
       LIMIT 1`,
    )
    .bind(today)
    .first();
  return row !== null;
}

/** A 'running' lock row older than this is stale (its isolate died mid-run)
 * and is swept by the next run. */
const STALE_LOCK_MS = 30 * 60 * 1000;

export type RunLock = { id: string } | 'held' | null;

/**
 * Strongly-consistent per-day run lock (the concurrent cron + admin guard).
 * A partial UNIQUE index — `generation_log(batch_date) WHERE status =
 * 'running'` — makes a second in-flight row for the same batch_date
 * impossible, so D1 itself is the lock; KV is eventually consistent and must
 * NOT be used for this.
 *
 * 1. Sweeps stale 'running' rows for the day (created_at older than 30 min;
 *    ISO text compares lexicographically). 2. Inserts this run's 'running'
 * row with INSERT OR IGNORE — `meta.changes === 0` means another run holds
 * the lock ('held').
 *
 * Returns the lock row id (later finalized in place by `finalizeRunLog`),
 * `'held'` when another run owns the lock, or null when D1 could not be
 * written (the run then proceeds best-effort, unlogged until the final write).
 */
export async function acquireRunLock(
  db: D1Database,
  batchDate: string,
  requested: number,
  model: string,
): Promise<RunLock> {
  try {
    const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    await db
      .prepare(`DELETE FROM generation_log WHERE status = 'running' AND batch_date = ? AND created_at < ?`)
      .bind(batchDate, cutoff)
      .run();

    const id = crypto.randomUUID();
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO generation_log
         (id, batch_date, requested, generated, duplicates_skip, duration_ms, model, status, error, created_at)
         VALUES (?, ?, ?, 0, 0, 0, ?, 'running', NULL, ?)`,
      )
      .bind(id, batchDate, requested, model, new Date().toISOString())
      .run();
    if ((result.meta?.changes ?? 0) === 0) return 'held';
    return { id };
  } catch {
    return null;
  }
}

/** Delete a still-'running' lock row (guard-hit path). Best effort. */
export async function releaseRunLock(db: D1Database, lockId: string | null): Promise<void> {
  if (lockId === null) return;
  try {
    await db.prepare(`DELETE FROM generation_log WHERE id = ? AND status = 'running'`).bind(lockId).run();
  } catch {
    // Stranded rows are swept by the next run after 30 minutes.
  }
}

export interface GenerationLogEntry {
  batchDate: string;
  requested: number;
  generated: number;
  duplicatesSkip: number;
  durationMs: number;
  model: string;
  status: string;
  error: string | null;
}

/** Append a run record to generation_log. Returns false on D1 failure. */
export async function logGeneration(db: D1Database, entry: GenerationLogEntry): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO generation_log
         (id, batch_date, requested, generated, duplicates_skip, duration_ms, model, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        entry.batchDate,
        entry.requested,
        entry.generated,
        entry.duplicatesSkip,
        entry.durationMs,
        entry.model,
        entry.status,
        entry.error,
        new Date().toISOString(),
      )
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Finalize a run by updating its 'running' lock row IN PLACE (same id, so a
 * run never leaves two rows behind). Falls back to appending a fresh row when
 * no lock row exists (lock acquisition failed) or the update fails. Returns
 * false only when neither write succeeded.
 */
export async function finalizeRunLog(db: D1Database, lockId: string | null, entry: GenerationLogEntry): Promise<boolean> {
  if (lockId !== null) {
    try {
      const result = await db
        .prepare(
          `UPDATE generation_log
           SET status = ?, generated = ?, duplicates_skip = ?, duration_ms = ?, model = ?, error = ?
           WHERE id = ?`,
        )
        .bind(entry.status, entry.generated, entry.duplicatesSkip, entry.durationMs, entry.model, entry.error, lockId)
        .run();
      if ((result.meta?.changes ?? 0) > 0) return true;
    } catch {
      // fall through to the append below
    }
  }
  return logGeneration(db, entry);
}

/** A claimed manual-run request, ready to be handed to the pipeline. */
export interface QueuedRun {
  requested: number;
}

// Queue a manual generation request (POST /api/generate). Executed later by
// the every-15-minutes cron poller: waitUntil promises on an HTTP fetch event
// are killed ~30 s after the response on the real runtime — too short for the
// ~77 s pipeline — while a cron invocation gets a 15-minute budget.
export async function queueRunRequest(db: D1Database, batchDate: string, requested: number): Promise<void> {
  await db
    .prepare('INSERT INTO run_requests (id, batch_date, requested, created_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), batchDate, requested, new Date().toISOString())
    .run();
}

// Atomically claim + remove the OLDEST pending run request for a date
// (created_at is ISO text, so it orders lexicographically; rowid breaks ties
// within the same millisecond). Claim happens BEFORE the run: if the DELETE
// reports 0 changes another consumer already took the row between our SELECT
// and DELETE — return null rather than double-running. (The pipeline's D1
// run lock still backstops a true concurrent double-run.)
export async function consumeRunRequest(db: D1Database, batchDate: string): Promise<QueuedRun | null> {
  const row = await db
    .prepare('SELECT id, requested FROM run_requests WHERE batch_date = ? ORDER BY created_at ASC, rowid ASC LIMIT 1')
    .bind(batchDate)
    .first<{ id: string; requested: number }>();
  if (row === null) return null;
  const deleted = await db.prepare('DELETE FROM run_requests WHERE id = ?').bind(row.id).run();
  if ((deleted.meta?.changes ?? 0) === 0) return null;
  return { requested: row.requested };
}
