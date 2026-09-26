/**
 * Integration test for the full generation pipeline (plan §6) — no Worker
 * runtime needed. Storage fakes:
 *
 * - DB: real SQLite via node:sqlite (Node >= 22.5) running the REAL
 *   schema.sql (including the run_requests manual-run queue), wrapped in a
 *   minimal D1Database-shaped adapter (prepare / bind / first / all / run /
 *   batch with transactional semantics). The UNIQUE(title_hash) constraint is
 *   therefore enforced by a real SQLite engine, exactly as D1 would.
 * - KV: in-memory namespace implementing get/put/delete/list with cursors.
 * - AI: global fetch is stubbed with a scripted OpenRouter server that
 *   recognizes each pipeline call by its prompt and replies with JSON.
 *
 * The REAL pipeline (runGeneration), REAL cron handler, and REAL route
 * handlers (handleToday, handleCards, handleGenerate, handleRunSync) run
 * against them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/index';
import { handleCards, handleToday } from '../src/routes/cards';
import { handleGenerate, handleRunSync } from '../src/routes/admin';
import { runGeneration } from '../src/generation/pipeline';
import { CANONICAL_CATEGORIES } from '../src/generation/categories';
import { normalizeTitle, sha256Prefix } from '../src/generation/dedup';
import { mergeTopicsDeterministic } from '../src/generation/topic-map';
import { consumeRunRequest, queueRunRequest } from '../src/lib/db';
import { withCors } from '../src/lib/cors';
import type { Env, NewTopic, TopicCoverageMap } from '../src/lib/types';

// ─── D1 fake over real SQLite ─────────────────────────────────────────────────

interface BoundCall {
  values: unknown[];
}

const VALIDATE_SQL = /insert into generated_cards/i;

class FakeBound {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly call: BoundCall,
  ) {}

  /** Execute for real: SELECTs return rows, writes return change counts. */
  private exec(): { rows: unknown[]; changes: number } {
    const stmt = this.sqlite.prepare(this.sql);
    const values = this.call.values as never[];
    if (/^\s*(select|with|pragma)/i.test(this.sql)) {
      return { rows: stmt.all(...values) as unknown[], changes: 0 };
    }
    const info = stmt.run(...values);
    return { rows: [], changes: Number(info.changes) };
  }

  async query<T>(): Promise<{ results: T[]; meta: { changes: number } }> {
    const { rows, changes } = this.exec();
    return { results: rows as T[], meta: { changes } };
  }

  async run(): Promise<{ results: unknown[]; meta: { changes: number } }> {
    return this.query();
  }

  async first<T>(): Promise<T | null> {
    const { results } = await this.query<T>();
    return results.length > 0 ? results[0] : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const { results } = await this.query<T>();
    return { results };
  }
}

interface Runnable {
  query<T>(): Promise<{ results: T[]; meta: { changes: number } }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

class FakeStatement implements Runnable {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
  ) {}

  /** Statements can be executed without bind() too (queryStats does). */
  query<T>() {
    return new FakeBound(this.sqlite, this.sql, { values: [] }).query<T>();
  }

  run() {
    return new FakeBound(this.sqlite, this.sql, { values: [] }).run();
  }

  first<T>() {
    return new FakeBound(this.sqlite, this.sql, { values: [] }).first<T>();
  }

  all<T>() {
    return new FakeBound(this.sqlite, this.sql, { values: [] }).all<T>();
  }

  bind(...values: unknown[]): FakeBound {
    return new FakeBound(this.sqlite, this.sql, { values });
  }
}

class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor(schemaSql: string) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(schemaSql);
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }

  /** Transactional like D1: a failed statement rolls the whole batch back. */
  async batch(statements: Runnable[]): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
    this.sqlite.exec('BEGIN');
    try {
      const results: Array<{ results: unknown[]; meta: { changes: number } }> = [];
      for (const stmt of statements) results.push(await stmt.query());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- test conveniences ----
  count(table: string): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  rows<T>(sql: string): T[] {
    return this.sqlite.prepare(sql).all() as T[];
  }
}

// ─── KV fake ──────────────────────────────────────────────────────────────────

class FakeKV {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<string | null> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix: string; limit: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
    const start = opts.cursor === undefined ? 0 : Number(opts.cursor);
    const page = names.slice(start, start + opts.limit);
    const complete = start + opts.limit >= names.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      ...(complete ? {} : { cursor: String(start + opts.limit) }),
    };
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  seed(key: string, value: unknown): void {
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

// ─── ExecutionContext fake ────────────────────────────────────────────────────

class FakeCtx {
  private pending: Promise<unknown>[] = [];

  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }

  passThroughOnException(): void {
    /* noop */
  }

  async settle(): Promise<void> {
    await Promise.all(this.pending.splice(0).map((p) => p.catch(() => undefined)));
  }
}

// ─── Env wiring ───────────────────────────────────────────────────────────────

const SCHEMA_SQL = readFileSync(`${dirname(fileURLToPath(import.meta.url))}/../schema.sql`, 'utf8');

interface TestHarness {
  db: FakeD1;
  kv: FakeKV;
  env: Env;
  ctx: FakeCtx;
}

function makeHarness(overrides: Partial<Env> = {}): TestHarness {
  const db = new FakeD1(SCHEMA_SQL);
  const kv = new FakeKV();
  const env = {
    DB: db as unknown as Env['DB'],
    KV: kv as unknown as Env['KV'],
    OPENROUTER_MODEL: 'test-model',
    OPENROUTER_BASE_URL: 'https://ai.test/v1',
    CORS_ORIGIN: 'https://frontend.test',
    OPENROUTER_API_KEY: 'test-key',
    ADMIN_SECRET: 'test-admin-secret',
    ...overrides,
  };
  return { db, kv, env, ctx: new FakeCtx() };
}

// ─── Scripted OpenRouter server ───────────────────────────────────────────────

const SYSTEM_MARKERS = {
  title: 'microlearning content curator',
  nearDedup: 'deduplication filter',
  expansion: 'microlearning card writer',
  mapUpdate: 'Update the topic coverage map',
};

const EXPANSION_BODY =
  '**Core insight.** Understanding this concept changes how you act every single day.\n\n' +
  '- Practical first step explained clearly here\n' +
  '- Practical second step explained clearly here\n\n' +
  '*Deeper implication.* ' +
  'Supporting detail sentence added for necessary length. '.repeat(7); // ~65 words

function validCard(title: string): { title: string; body: string; source: string; tags: string[] } {
  return {
    title,
    body: EXPANSION_BODY,
    source: 'A Real Book, 2020',
    tags: ['Mindset'],
  };
}

function makeTitleCandidates(n: number, prefix = 'Generated Concept'): Array<{
  title: string;
  category: string;
  subcategory: string;
  topic_slug: string;
}> {
  return Array.from({ length: n }, (_, i) => ({
    title: `${prefix} Number ${i + 1}`,
    category: CANONICAL_CATEGORIES[i % CANONICAL_CATEGORIES.length],
    subcategory: `Subtopic ${(i % 8) + 1}`,
    topic_slug: `${prefix.toLowerCase().replace(/\s+/g, '-')}-number-${i + 1}`,
  }));
}

/** Extract the first JSON array/object that appears after `marker`. */
function jsonAfter(text: string, marker: string, open: '[' | '{'): unknown {
  const close = open === '[' ? ']' : '}';
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const start = text.indexOf(open, idx + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  return null;
}

type AiScript = (kind: string, requestBody: string) => { content: string } | Response;

function aiResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
    { status: 200 },
  );
}

/** Default behavior: every call succeeds per the plan's happy path. */
function defaultScript(kind: string, body: string): { content: string } | Response {
  if (kind === 'title') {
    // Fenced + surrounded by prose on purpose: exercises extractJson.
    const fenced = '```json\n' + JSON.stringify({ titles: makeTitleCandidates(60) }) + '\n```';
    return { content: `Here are your titles!\n${fenced}\nHope that helps!` };
  }
  if (kind === 'nearDedup') {
    const candidates = jsonAfter(body, 'CANDIDATES:', '[') as Array<{ title: string }> | null;
    return { content: JSON.stringify({ approved: candidates ?? [] }) };
  }
  if (kind === 'expansion') {
    const titles = jsonAfter(body, 'TITLES TO EXPAND:', '[') as Array<{ title: string }> | null;
    return { content: JSON.stringify((titles ?? []).map((t) => validCard(t.title))) };
  }
  if (kind === 'mapUpdate') {
    const current = jsonAfter(body, 'CURRENT MAP:', '{') as TopicCoverageMap | null;
    const newTopics = (jsonAfter(body, 'NEW TOPICS TO MERGE:', '[') ?? []) as NewTopic[];
    if (current === null) return new Response('nope', { status: 500 });
    return { content: JSON.stringify(mergeTopicsDeterministic(current, newTopics)) };
  }
  return new Response('unexpected call', { status: 500 });
}

function classify(body: string): string {
  if (body.includes(SYSTEM_MARKERS.title)) return 'title';
  if (body.includes(SYSTEM_MARKERS.nearDedup)) return 'nearDedup';
  if (body.includes(SYSTEM_MARKERS.expansion)) return 'expansion';
  if (body.includes(SYSTEM_MARKERS.mapUpdate)) return 'mapUpdate';
  return 'unknown';
}

function stubFetch(script: AiScript): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.includes('/chat/completions')) return new Response('not found', { status: 404 });
      // Decode the JSON-encoded request body so prompt scanning sees the real text.
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        messages?: Array<{ content?: string }>;
      };
      const decoded = (payload.messages ?? []).map((m) => m.content ?? '').join('\n');
      const scripted = script(classify(decoded), decoded);
      if (scripted instanceof Response) return scripted;
      return aiResponse(scripted.content);
    }),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runCron(h: TestHarness, cron = '0 5 * * *'): Promise<void> {
  const controller = {
    cron,
    scheduledTime: Date.now(),
  } as unknown as ScheduledController;
  await worker.scheduled(controller, h.env, h.ctx as unknown as ExecutionContext);
  await h.ctx.settle();
}

// The every-15-minutes poller fire that executes queued manual runs.
async function runPoller(h: TestHarness): Promise<void> {
  await runCron(h, '*/15 * * * *');
}

async function runAdmin(h: TestHarness, init?: RequestInit): Promise<Response> {
  const request = new Request('https://api.test/api/generate', {
    method: 'POST',
    ...init,
  });
  return handleGenerate(request, h.env, withCors(h.env));
}

// The synchronous twin: same env/auth, but the pipeline runs INLINE and the
// response only arrives once the batch is done.
async function runSync(h: TestHarness, init?: RequestInit): Promise<Response> {
  const request = new Request('https://api.test/api/run-sync', {
    method: 'POST',
    ...init,
  });
  return handleRunSync(request, h.env, withCors(h.env), h.ctx as unknown as ExecutionContext);
}

interface CardRow {
  id: string;
  title: string;
  title_hash: string;
  batch_date: string;
  category: string;
  subcategory: string;
  topic_slug: string;
}

async function seedExistingCard(db: FakeD1, title: string): Promise<void> {
  const hash = await sha256Prefix(normalizeTitle(title));
  db.sqlite
    .prepare(
      `INSERT INTO generated_cards (id, title, body, source, tags, category, subcategory, topic_slug, title_hash, batch_date, created_at, word_count)
       VALUES (?, ?, ?, ?, '[]', 'Old', '', 'old-slug', ?, '2026-01-01', '2026-01-01T00:00:00Z', 60)`,
    )
    .run(crypto.randomUUID(), title, 'x '.repeat(60), 'Old Source', hash);
}

const today = new Date().toISOString().slice(0, 10);

// ─── Tests ────────────────────────────────────────────────────────────────────

let h: TestHarness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pipeline happy path (cron)', () => {
  test('inserts 50 cards, logs success, updates the map, is idempotent, serves /today', async () => {
    // Stale cache entries present before the run — must be invalidated.
    h.kv.seed('api-cache:today', JSON.stringify({ cards: [{ id: 'stale' }], batchDate: '2020-01-01' }));
    h.kv.seed('api-cache:cards:stale-key', JSON.stringify({ cards: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } }));

    stubFetch(defaultScript);
    await runCron(h);

    // ---- D1 state
    expect(h.db.count('generated_cards')).toBe(50);
    const rows = h.db.rows<CardRow>('SELECT id, title, title_hash, batch_date, category, topic_slug FROM generated_cards');
    expect(rows.every((r) => r.batch_date === today)).toBe(true);
    const distinctCategories = new Set(rows.map((r) => r.category));
    expect(distinctCategories.size).toBeGreaterThanOrEqual(6);
    const distinctHashes = new Set(rows.map((r) => r.title_hash));
    expect(distinctHashes.size).toBe(50);
    for (const r of rows) expect(r.title_hash).toHaveLength(16);

    // ---- generation_log
    const log = h.db.rows<{
      status: string;
      requested: number;
      generated: number;
      duplicates_skip: number;
      model: string;
      error: null;
    }>('SELECT status, requested, generated, duplicates_skip, model, error FROM generation_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'success', requested: 50, generated: 50, duplicates_skip: 0, model: 'test-model', error: null });

    // ---- topic map updated (version+1, slugs merged, recentTopicSlugs)
    const map = (await h.kv.get('topic-coverage-map', 'json')) as unknown as TopicCoverageMap;
    expect(map.version).toBe(2);
    expect(map.totalCards).toBe(50);
    expect(map.recentTopicSlugs).toHaveLength(50);
    const mergedSlugs = new Set(Object.values(map.categories).flatMap((subs) => Object.values(subs).flat()));
    for (const slug of rows.map((r) => r.topic_slug)) expect(mergedSlugs.has(slug)).toBe(true);

    // ---- cache invalidation happened during the run
    expect(h.kv.has('api-cache:today')).toBe(false);
    expect(h.kv.has('api-cache:cards:stale-key')).toBe(false);

    // ---- second run the same day: skipped, nothing changed
    await runCron(h);
    expect(h.db.count('generated_cards')).toBe(50);
    expect(h.db.count('generation_log')).toBe(1);
    expect((((await h.kv.get('topic-coverage-map', 'json')) as unknown as TopicCoverageMap).version)).toBe(2);

    // ---- GET /api/cards/today returns the batch (camelCase, cached)
    const res = await handleToday(new Request('https://api.test/api/cards/today'), h.env, withCors(h.env));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=21000');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test');
    const payload = (await res.json()) as { cards: Array<Record<string, unknown>>; batchDate: string };
    expect(payload.cards).toHaveLength(50);
    expect(payload.batchDate).toBe(today);
    const first = payload.cards[0];
    expect(first).toHaveProperty('createdAt');
    expect(first).toHaveProperty('batchDate');
    expect(first).not.toHaveProperty('created_at');
    expect(Array.isArray(first.tags)).toBe(true);
    expect(typeof first.source).toBe('string');
    expect(new Date(first.createdAt as string).toString()).not.toBe('Invalid Date');
    expect(h.kv.has('api-cache:today')).toBe(true);

    // Cached payload survives even with the D1 table gone (KV hit).
    h.db.sqlite.exec('DELETE FROM generated_cards');
    const res2 = await handleToday(new Request('https://api.test/api/cards/today'), h.env, withCors(h.env));
    const payload2 = (await res2.json()) as { cards: unknown[] };
    expect(payload2.cards).toHaveLength(50);
  });

  test('GET /api/cards paginates, filters by category/tag/date, and clamps params', async () => {
    stubFetch(defaultScript);
    await runCron(h);

    const cors = withCors(h.env);
    const call = (qs: string) => handleCards(new Request(`https://api.test/api/cards${qs}`), h.env, cors);

    const all = await call('?limit=10');
    expect(all.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const allBody = (await all.json()) as { cards: unknown[]; pagination: { page: number; limit: number; total: number; pages: number } };
    expect(allBody.cards).toHaveLength(10);
    expect(allBody.pagination).toEqual({ page: 1, limit: 10, total: 50, pages: 5 });

    const page3 = (await (await call('?limit=10&page=3')).json()) as { cards: unknown[] };
    expect(page3.cards).toHaveLength(10);

    const emptyPage = (await (await call('?limit=10&page=99')).json()) as { cards: unknown[] };
    expect(emptyPage.cards).toHaveLength(0);

    const clamped = (await (await call('?limit=999')).json()) as { pagination: { limit: number } };
    expect(clamped.pagination.limit).toBe(50);

    const defaulted = (await (await call('?limit=abc')).json()) as { pagination: { limit: number } };
    expect(defaulted.pagination.limit).toBe(20);

    const byCategory = (await (await call('?category=Mindset')).json()) as { cards: Array<{ category: string }>; pagination: { total: number } };
    expect(byCategory.pagination.total).toBeGreaterThan(0);
    expect(byCategory.cards.every((c) => c.category === 'Mindset')).toBe(true);

    const byTag = (await (await call('?tag=Mindset')).json()) as { cards: Array<{ tags: string[] }>; pagination: { total: number } };
    expect(byTag.pagination.total).toBeGreaterThan(0);
    expect(byTag.cards.every((c) => c.tags.includes('Mindset'))).toBe(true);

    const byDate = (await (await call(`?date=${today}`)).json()) as { pagination: { total: number } };
    expect(byDate.pagination.total).toBe(50);

    const badDate = (await (await call('?date=not-a-date')).json()) as { pagination: { total: number } };
    expect(badDate.pagination.total).toBe(50); // invalid date ignored

    expect(h.kv.has('api-cache:today')).toBe(false);
    const list = await h.kv.list({ prefix: 'api-cache:cards:', limit: 100 });
    expect(list.keys.length).toBeGreaterThan(0);
  });
});

describe('dedup soundness', () => {
  test('expansion rewriting a title onto an existing one is caught at insert time', async () => {
    await seedExistingCard(h.db, 'Pre Existing Concept');
    stubFetch((kind, body) => {
      if (kind === 'title') {
        const titles = makeTitleCandidates(60);
        titles[0] = { ...titles[0], title: 'Fresh Original Idea', topic_slug: 'fresh-original-idea' };
        return { content: JSON.stringify({ titles }) };
      }
      if (kind === 'expansion') {
        const titles = jsonAfter(body, 'TITLES TO EXPAND:', '[') as Array<{ title: string }> | null;
        if (titles === null) return { content: '[]' };
        const cards = titles.map((t) => validCard(t.title));
        // The first batch ALSO emits a card REWRITTEN onto an existing title.
        if (cards.some((c) => c.title === 'Fresh Original Idea')) {
          cards[0] = validCard('Pre Existing Concept'); // positional pair -> candidate 'Fresh Original Idea'
          cards.push(validCard('Fresh Original Idea')); // the real title still expanded
        }
        return { content: JSON.stringify(cards) };
      }
      return defaultScript(kind, body);
    });

    await runCron(h);

    expect(h.db.count('generated_cards')).toBe(51); // 50 new + 1 pre-existing
    const newRows = h.db.rows<CardRow>(`SELECT title, title_hash FROM generated_cards WHERE batch_date = '${today}'`);
    expect(newRows).toHaveLength(50);
    expect(newRows.some((r) => r.title === 'Fresh Original Idea')).toBe(true);
    expect(newRows.some((r) => r.title === 'Pre Existing Concept')).toBe(false);
    const hashes = new Set(newRows.map((r) => r.title_hash));
    expect(hashes.size).toBe(50);

    const log = h.db.rows<{ status: string; generated: number; duplicates_skip: number }>(
      'SELECT status, generated, duplicates_skip FROM generation_log',
    );
    expect(log[0]).toMatchObject({ status: 'success', generated: 50, duplicates_skip: 1 });
  });

  test('two expansion batches returning the same title insert exactly one row', async () => {
    stubFetch((kind, body) => {
      if (kind === 'expansion') {
        const titles = jsonAfter(body, 'TITLES TO EXPAND:', '[') as Array<{ title: string }> | null;
        const cards = (titles ?? []).map((t) => validCard(t.title));
        // Both batch 1 and batch 2 emit this extra title.
        if ((titles ?? []).some((t) => t.title === 'Generated Concept Number 1' || t.title === 'Generated Concept Number 11')) {
          if (cards.length > 0) cards[0] = validCard('Cross Batch Twin');
        }
        return { content: JSON.stringify(cards) };
      }
      return defaultScript(kind, body);
    });

    await runCron(h);
    const twins = h.db.rows<CardRow>("SELECT title FROM generated_cards WHERE title = 'Cross Batch Twin'");
    expect(twins).toHaveLength(1);
    expect(h.db.count('generated_cards')).toBe(49);
  });
});

describe('canonical category enforcement', () => {
  test('Technology is aliased to Tech, History is dropped, and the batch still fills from the surplus', async () => {
    stubFetch((kind, body) => {
      if (kind === 'title') {
        const titles = makeTitleCandidates(60);
        titles[0] = { ...titles[0], category: 'Technology' }; // known alias
        titles[1] = { ...titles[1], category: 'History' }; // off-schema -> dropped
        return { content: JSON.stringify({ titles }) };
      }
      return defaultScript(kind, body);
    });

    const result = await runGeneration(h.env, h.ctx as unknown as ExecutionContext, { requested: 5 });

    expect(result.status).toBe('success');
    expect(result.generated).toBe(5); // the surplus absorbs the dropped title
    const rows = h.db.rows<CardRow>(
      `SELECT title, category, subcategory FROM generated_cards WHERE batch_date = '${today}'`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.title === 'Generated Concept Number 1')?.category).toBe('Tech');
    expect(rows.some((r) => r.title === 'Generated Concept Number 2')).toBe(false);
    expect(rows.every((r) => (CANONICAL_CATEGORIES as readonly string[]).includes(r.category))).toBe(true);
    // Only categories are enumerated — the free-text subcategory survives.
    expect(rows.find((r) => r.title === 'Generated Concept Number 1')?.subcategory).toBe('Subtopic 1');
    expect(result.warnings).toContain('dropped 1 title(s) with non-canonical categories (History)');
  });

  test('casing differences are normalized to the canonical spelling without a drop warning', async () => {
    stubFetch((kind, body) => {
      if (kind === 'title') {
        const titles = makeTitleCandidates(60);
        titles[0] = { ...titles[0], category: 'TECH' };
        return { content: JSON.stringify({ titles }) };
      }
      return defaultScript(kind, body);
    });

    const result = await runGeneration(h.env, h.ctx as unknown as ExecutionContext, { requested: 1 });

    expect(result.status).toBe('success');
    expect(result.warnings).toHaveLength(1); // only the KV-map fallback warning
    const row = h.db.rows<CardRow>("SELECT category FROM generated_cards WHERE title = 'Generated Concept Number 1'")[0];
    expect(row.category).toBe('Tech');
  });
});

describe('hostile AI output', () => {
  test('unparseable title JSON twice -> failed run, no cards, retry allowed', async () => {
    stubFetch(() => ({ content: 'I cannot do that, sorry. No JSON here.' }));
    await runCron(h);
    expect(h.db.count('generated_cards')).toBe(0);
    const log = h.db.rows<{ status: string; error: string }>('SELECT status, error FROM generation_log');
    expect(log[0].status).toBe('failed');
    expect(log[0].error).toContain('minimum 10');
    // A failed day allows a retry (guard only blocks success/partial).
    await runCron(h);
    expect(h.db.count('generation_log')).toBe(2);
  });

  test('fewer than 10 valid candidates -> failed run', async () => {
    stubFetch((kind) => (kind === 'title' ? { content: JSON.stringify({ titles: makeTitleCandidates(3) }) } : defaultScript(kind, '')));
    await runCron(h);
    const log = h.db.rows<{ status: string; error: string }>('SELECT status, error FROM generation_log');
    expect(log[0].status).toBe('failed');
    expect(log[0].error).toContain('minimum 10');
  });

  test('wrong types, missing fields, short bodies and dupes are dropped without crashing', async () => {
    stubFetch((kind, body) => {
      if (kind === 'expansion') {
        const titles = jsonAfter(body, 'TITLES TO EXPAND:', '[') as Array<{ title: string }> | null;
        const list = (titles ?? []).slice(0, 6).map((t) => validCard(t.title));
        list.push(
          { title: 'Short Body', body: 'too short', source: 'x', tags: ['Mindset'] },
          { title: 'No Source', body: EXPANSION_BODY, source: '', tags: ['Mindset'] },
          { title: 'No Tags', body: EXPANSION_BODY, source: 'src', tags: [] },
          { title: 42 as unknown as string, body: EXPANSION_BODY, source: 'src', tags: ['Mindset'] },
          list[0], // exact duplicate of the first card
        );
        return { content: JSON.stringify(list) };
      }
      return defaultScript(kind, body);
    });

    await runCron(h);
    // 6 valid cards per batch x 5 batches = 30 (< 40 => partial).
    expect(h.db.count('generated_cards')).toBe(30);
    const log = h.db.rows<{ status: string; generated: number; error: string | null }>(
      'SELECT status, generated, error FROM generation_log',
    );
    expect(log[0]).toMatchObject({ status: 'partial', generated: 30 });
    expect(log[0].error).toContain('produced no valid card');
  });

  test('100 candidates when 60 requested are capped at the requested 50', async () => {
    stubFetch((kind, body) =>
      kind === 'title' ? { content: JSON.stringify({ titles: makeTitleCandidates(100) }) } : defaultScript(kind, body),
    );
    await runCron(h);
    expect(h.db.count('generated_cards')).toBe(50);
    expect(h.db.rows<{ status: string }>('SELECT status FROM generation_log')[0].status).toBe('success');
  });

  test('all candidates already in D1 -> 0-card partial day that allows retry, map untouched', async () => {
    for (const t of makeTitleCandidates(60)) await seedExistingCard(h.db, t.title);
    h.kv.seed('api-cache:today', JSON.stringify({ cards: [] }));

    stubFetch(defaultScript);
    await runCron(h);

    expect(h.db.count('generated_cards')).toBe(60); // only the pre-seeded ones
    const log = h.db.rows<{ status: string; generated: number }>('SELECT status, generated FROM generation_log');
    expect(log[0]).toMatchObject({ status: 'partial', generated: 0 });
    // No cards inserted -> the map is never written back (the default map is
    // only used in memory), so KV stays empty rather than being corrupted.
    expect(await h.kv.get('topic-coverage-map', 'json')).toBeNull();
    expect(h.kv.has('api-cache:today')).toBe(false); // invalidation is unconditional

    // A 0-card partial day is retryable (only a partial WITH cards blocks).
    await runCron(h);
    const afterRetry = h.db.rows<{ status: string; generated: number }>(
      'SELECT status, generated FROM generation_log ORDER BY rowid',
    );
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry[1]).toMatchObject({ status: 'partial', generated: 0 });
  });
});

describe('concurrent-run lock (D1 partial unique index)', () => {
  function insertRunningRow(db: FakeD1, batchDate: string, createdAt: string): void {
    db.sqlite
      .prepare(
        `INSERT INTO generation_log (id, batch_date, requested, generated, duplicates_skip, duration_ms, model, status, error, created_at)
         VALUES (?, ?, 50, 0, 0, 0, 'test-model', 'running', NULL, ?)`,
      )
      .run(crypto.randomUUID(), batchDate, createdAt);
  }

  test('a live running lock row makes the run skip with reason lock-held', async () => {
    stubFetch(defaultScript);
    insertRunningRow(h.db, today, new Date().toISOString());

    const result = await runGeneration(h.env, h.ctx as unknown as ExecutionContext);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('lock-held');
    expect(result.skipped).toBe(true);
    expect(h.db.count('generated_cards')).toBe(0);
    // The lock holder's row is untouched — exactly one row, still running.
    const rows = h.db.rows<{ status: string }>('SELECT status FROM generation_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('running');
  });

  test('a stale running lock row (31 min old) is swept and the run proceeds to a final row', async () => {
    stubFetch(defaultScript);
    insertRunningRow(h.db, today, new Date(Date.now() - 31 * 60 * 1000).toISOString());

    const result = await runGeneration(h.env, h.ctx as unknown as ExecutionContext);

    expect(result.status).toBe('success');
    expect(h.db.count('generated_cards')).toBe(50);
    // The stale row was swept; the run's own lock row was finalized in place.
    const rows = h.db.rows<{ status: string; generated: number }>('SELECT status, generated FROM generation_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', generated: 50 });
    expect(h.db.rows<{ id: string }>("SELECT id FROM generation_log WHERE status = 'running'")).toHaveLength(0);
  });

  test('a hard AI failure mid-run finalizes the lock row as failed and a retry is allowed', async () => {
    // Non-retryable 401 with a non-JSON body -> callAI throws on the title call.
    stubFetch((kind) => (kind === 'title' ? new Response('provider exploded', { status: 401 }) : defaultScript(kind, '')));

    const result = await runGeneration(h.env, h.ctx as unknown as ExecutionContext);
    expect(result.status).toBe('failed');

    const rows = h.db.rows<{ status: string; error: string; generated: number }>(
      'SELECT status, error, generated FROM generation_log',
    );
    expect(rows).toHaveLength(1); // the running row became the final row
    expect(rows[0]).toMatchObject({ status: 'failed', generated: 0 });
    expect(rows[0].error).toContain('title generation AI call failed');
    expect(h.db.rows<{ id: string }>("SELECT id FROM generation_log WHERE status = 'running'")).toHaveLength(0);
    expect(h.db.count('generated_cards')).toBe(0);

    // A failed day allows a retry: the next run generates normally.
    stubFetch(defaultScript);
    const retry = await runGeneration(h.env, h.ctx as unknown as ExecutionContext);
    expect(retry.status).toBe('success');
    expect(h.db.count('generated_cards')).toBe(50);
    expect(h.db.count('generation_log')).toBe(2);
  });

  test('an unexpected mid-pipeline crash leaves a failed (never running) row and a retry is allowed', async () => {
    stubFetch(defaultScript);
    const originalPrepare = h.db.prepare.bind(h.db);
    h.db.prepare = (sql: string) => {
      if (VALIDATE_SQL.test(sql)) throw new Error('D1 exploded');
      return originalPrepare(sql);
    };

    await expect(runGeneration(h.env, h.ctx as unknown as ExecutionContext)).rejects.toThrow('D1 exploded');

    const rows = h.db.rows<{ status: string; error: string }>('SELECT status, error FROM generation_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed'); // finalized by the crash path
    expect(rows[0].error).toContain('D1 exploded');
    expect(h.db.rows<{ id: string }>("SELECT id FROM generation_log WHERE status = 'running'")).toHaveLength(0);
    expect(h.db.count('generated_cards')).toBe(0);

    h.db.prepare = originalPrepare;
    const retry = await runGeneration(h.env, h.ctx as unknown as ExecutionContext);
    expect(retry.status).toBe('success');
    expect(h.db.count('generation_log')).toBe(2);
  });
});

describe('admin route, auth and CORS', () => {
  test('401 without/with-wrong bearer, 503 without OPENROUTER_API_KEY, 202 then already_completed', async () => {
    stubFetch(defaultScript);

    const noAuth = await runAdmin(h);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await runAdmin(h, { headers: { Authorization: 'Bearer wrong-secret' } });
    expect(wrongAuth.status).toBe(401);

    const noKey = makeHarness({ OPENROUTER_API_KEY: undefined });
    const gen503 = await runAdmin(noKey, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(gen503.status).toBe(503);

    const noAdminSecret = makeHarness({ ADMIN_SECRET: undefined });
    const secret503 = await runAdmin(noAdminSecret);
    expect(secret503.status).toBe(503);

    const queued = await runAdmin(h, {
      headers: { Authorization: 'Bearer test-admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested: 50 }),
    });
    expect(queued.status).toBe(202);
    // 202 = QUEUED (not 'started') — the */15 poller executes it. See the
    // 'manual run queue' describe below and README deviation #17.
    expect(await queued.json()).toEqual({ status: 'queued', batchDate: today });
    expect(h.db.count('run_requests')).toBe(1);
    await runPoller(h);
    expect(h.db.count('generated_cards')).toBe(50);

    const again = await runAdmin(h, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'already_completed', batchDate: today });
    expect(h.db.count('generated_cards')).toBe(50);
  });

  test('worker.fetch: OPTIONS preflight, 404, 405, and GET routes', async () => {
    stubFetch(defaultScript);
    const fetchHandler = worker.fetch as (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
    const ctx = h.ctx as unknown as ExecutionContext;

    const preflight = await fetchHandler(new Request('https://api.test/api/cards', { method: 'OPTIONS' }), h.env, ctx);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    const notFound = await fetchHandler(new Request('https://api.test/nope'), h.env, ctx);
    expect(notFound.status).toBe(404);

    const methodNotAllowed = await fetchHandler(new Request('https://api.test/api/cards', { method: 'DELETE' }), h.env, ctx);
    expect(methodNotAllowed.status).toBe(405);

    await runCron(h);
    const stats = await fetchHandler(new Request('https://api.test/api/stats'), h.env, ctx);
    const statsBody = (await stats.json()) as { totalCards: number; totalBatches: number; lastBatchDate: string; topicMapVersion: number };
    expect(statsBody).toMatchObject({ totalCards: 50, totalBatches: 1, lastBatchDate: today, topicMapVersion: 2 });
    expect(stats.headers.get('Cache-Control')).toBe('max-age=300');

    const generate = await runGeneration(h.env, h.ctx as unknown as ExecutionContext, { requested: 1 });
    expect(generate.status).toBe('skipped');
  });
});

describe('admin run-sync (POST /api/run-sync — pipeline awaited inline)', () => {
  function insertSuccessRow(db: FakeD1, batchDate: string): void {
    db.sqlite
      .prepare(
        `INSERT INTO generation_log (id, batch_date, requested, generated, duplicates_skip, duration_ms, model, status, error, created_at)
         VALUES (?, ?, 50, 50, 0, 0, 'test-model', 'success', NULL, ?)`,
      )
      .run(crypto.randomUUID(), batchDate, new Date().toISOString());
  }

  test('401 without/with-wrong bearer, 503 without ADMIN_SECRET, 503 without OPENROUTER_API_KEY', async () => {
    stubFetch(defaultScript);

    const noAuth = await runSync(h);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await runSync(h, { headers: { Authorization: 'Bearer wrong-secret' } });
    expect(wrongAuth.status).toBe(401);

    const noAdminSecret = makeHarness({ ADMIN_SECRET: undefined });
    const secret503 = await runSync(noAdminSecret);
    expect(secret503.status).toBe(503);

    const noKey = makeHarness({ OPENROUTER_API_KEY: undefined });
    const gen503 = await runSync(noKey, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(gen503.status).toBe(503);

    // Nothing was generated, logged, or queued by the rejected calls.
    expect(h.db.count('generated_cards')).toBe(0);
    expect(h.db.count('generation_log')).toBe(0);
    expect(h.db.count('run_requests')).toBe(0);
  });

  test('400 on invalid JSON body and on a non-numeric requested', async () => {
    stubFetch(defaultScript);
    const auth = { Authorization: 'Bearer test-admin-secret' };

    const badJson = await runSync(h, { headers: auth, body: '{nope' });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: 'invalid json body' });

    const badRequested = await runSync(h, {
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested: 'fifty' }),
    });
    expect(badRequested.status).toBe(400);
    expect(await badRequested.json()).toEqual({ error: 'invalid requested value' });

    expect(h.db.count('generated_cards')).toBe(0);
    expect(h.db.count('generation_log')).toBe(0);
  });

  test('already_completed fast-path: a success row for today short-circuits with NO AI call', async () => {
    const fetchMock = vi.fn(async () => new Response('no AI call expected', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    insertSuccessRow(h.db, today);

    const res = await runSync(h, { headers: { Authorization: 'Bearer test-admin-secret' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'already_completed', batchDate: today });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.count('generated_cards')).toBe(0);
    // Executed inline means never queued.
    expect(h.db.count('run_requests')).toBe(0);
  });

  test('happy path: awaits the pipeline inline — 200 completed, cards land in D1, nothing queued', async () => {
    stubFetch(defaultScript);

    const res = await runSync(h, {
      headers: { Authorization: 'Bearer test-admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requested: 5 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'completed',
      batchDate: today,
      requested: 5,
      generated: 5,
      skippedDuplicates: 0,
      durationMs: expect.any(Number),
      // Fresh harness: no KV map seeded, so the pipeline notes its fallback.
      warnings: ['topic-coverage-map missing or corrupt in KV; using the baked-in default map'],
    });
    expect(h.db.count('generated_cards')).toBe(5);
    expect(h.db.count('run_requests')).toBe(0);
    expect(h.db.rows<{ status: string; requested: number }>('SELECT status, requested FROM generation_log')[0]).toMatchObject({
      status: 'success',
      requested: 5,
    });
  });

  test('failure path: hard AI failure → 502 generation_failed, run logged as failed, day retryable', async () => {
    // Non-retryable 401 with a non-JSON body on the title call: the pipeline
    // catches it, finalizes generation_log as 'failed', and RESOLVES with
    // status 'failed' — which the endpoint reports as 502 so an operator is
    // not told a dead run completed.
    stubFetch((kind) => (kind === 'title' ? new Response('provider exploded', { status: 401 }) : defaultScript(kind, '')));

    const res = await runSync(h, { headers: { Authorization: 'Bearer test-admin-secret' } });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'generation_failed', detail: expect.any(String) });
    expect(h.db.count('generated_cards')).toBe(0);
    expect(h.db.rows<{ status: string }>('SELECT status FROM generation_log')[0].status).toBe('failed');
    expect(h.db.count('run_requests')).toBe(0);

    // A failed day is retryable: the healthy retry completes inline.
    stubFetch(defaultScript);
    const retry = await runSync(h, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { status: string }).status).toBe('completed');
    expect(h.db.count('generated_cards')).toBe(50);
  });

  test('worker.fetch dispatch: POST /api/run-sync runs inline, GET is a 405', async () => {
    stubFetch(defaultScript);
    const fetchHandler = worker.fetch as (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
    const ctx = h.ctx as unknown as ExecutionContext;

    const notAllowed = await fetchHandler(new Request('https://api.test/api/run-sync'), h.env, ctx);
    expect(notAllowed.status).toBe(405);

    const res = await fetchHandler(
      new Request('https://api.test/api/run-sync', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-admin-secret' },
      }),
      h.env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('completed');
    expect(h.db.count('generated_cards')).toBe(50);
    await h.ctx.settle(); // cache invalidation was handed to waitUntil
  });
});

describe('manual run queue (POST /api/generate → run_requests → */15 poller)', () => {
  test('queue → consume returns it → the scheduled-handler path generates the cards', async () => {
    stubFetch(defaultScript);

    await queueRunRequest(h.env.DB, today, 3);
    expect(h.db.count('run_requests')).toBe(1);
    // Consume claims AND removes: a second consumer finds nothing.
    expect(await consumeRunRequest(h.env.DB, today)).toEqual({ requested: 3 });
    expect(h.db.count('run_requests')).toBe(0);

    // Re-queue and let the REAL scheduled handler pick it up (poller cron).
    await queueRunRequest(h.env.DB, today, 5);
    await runPoller(h);

    expect(h.db.count('generated_cards')).toBe(5);
    const log = h.db.rows<{ status: string; requested: number }>('SELECT status, requested FROM generation_log');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'success', requested: 5 });
    expect(h.db.count('run_requests')).toBe(0);
  });

  test('poller cron with NO pending request is a no-op — no AI call, no log row', async () => {
    const fetchMock = vi.fn(async () => new Response('no AI call expected', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await runPoller(h);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.count('generated_cards')).toBe(0);
    expect(h.db.count('generation_log')).toBe(0);
    expect(h.db.count('run_requests')).toBe(0);
  });

  test('two consumeRunRequest calls for one queued request → the second gets null (oldest first)', async () => {
    await queueRunRequest(h.env.DB, today, 10);
    expect(await consumeRunRequest(h.env.DB, today)).toEqual({ requested: 10 });
    expect(await consumeRunRequest(h.env.DB, today)).toBeNull();

    // Two queued: FIFO by created_at (rowid breaks same-millisecond ties).
    await queueRunRequest(h.env.DB, today, 1);
    await queueRunRequest(h.env.DB, today, 2);
    expect(await consumeRunRequest(h.env.DB, today)).toEqual({ requested: 1 });
    expect(await consumeRunRequest(h.env.DB, today)).toEqual({ requested: 2 });
    expect(await consumeRunRequest(h.env.DB, today)).toBeNull();
  });

  test('admin POST on a fresh day → 202 queued + a run_requests row and NO generation_log row; the poller then generates', async () => {
    stubFetch(defaultScript);

    const res = await runAdmin(h, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'queued', batchDate: today });

    // Queued, not started: no pipeline attempt has happened yet.
    expect(h.db.count('run_requests')).toBe(1);
    expect(h.db.count('generation_log')).toBe(0);
    expect(h.db.count('generated_cards')).toBe(0);

    await runPoller(h);
    expect(h.db.count('generated_cards')).toBe(50);
    expect(h.db.count('run_requests')).toBe(0);
    expect(h.db.rows<{ status: string }>('SELECT status FROM generation_log')[0].status).toBe('success');
  });

  test('admin POST when the day is already completed → 200 already_completed, nothing queued', async () => {
    stubFetch(defaultScript);
    await runCron(h);
    expect(h.db.count('generated_cards')).toBe(50);

    const res = await runAdmin(h, { headers: { Authorization: 'Bearer test-admin-secret' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'already_completed', batchDate: today });
    expect(h.db.count('run_requests')).toBe(0);
    expect(h.db.count('generation_log')).toBe(1); // only the cron's row
  });

  test('daily cron (0 5 * * *) with NO pending request still runs the pipeline', async () => {
    stubFetch(defaultScript);
    expect(h.db.count('run_requests')).toBe(0);

    await runCron(h); // helper fires controller.cron = '0 5 * * *'

    expect(h.db.count('generated_cards')).toBe(50);
    expect(h.db.count('generation_log')).toBe(1);
    expect(h.db.rows<{ status: string }>('SELECT status FROM generation_log')[0].status).toBe('success');
  });
});
