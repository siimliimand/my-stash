# My Stash API — Cloudflare Worker backend

REST API + daily AI generation pipeline for "My Stash": 16 new microlearning
cards per day (2 per canonical category — 8 categories), generated via
OpenRouter, stored in D1, deduplicated with a KV topic-coverage map, exposed to
the static Next.js frontend on Cloudflare Pages.

Implementation follows `docs/ai-backend-plan.md` (prompts §12 and schema §4 are
verbatim from the plan). Deviations from the plan are listed at the bottom.

```
workers/
├── src/
│   ├── index.ts              # Worker entry — routes + cron handler
│   ├── routes/
│   │   ├── cards.ts          # GET /api/cards, GET /api/cards/today
│   │   ├── stats.ts          # GET /api/stats
│   │   └── admin.ts          # POST /api/generate + /api/run-sync (secret-gated)
│   ├── generation/
│   │   ├── pipeline.ts       # runGeneration() — plan §6 steps 1–10
│   │   ├── topic-map.ts      # coverage map load/validate/merge (+ local fallback)
│   │   ├── ai-client.ts      # OpenRouter wrapper: retries, JSON mode, validation
│   │   ├── prompts.ts        # the four prompt templates (plan §12, verbatim
│   │   │                     #   except the title prompt's quota — deviation #20)
│   │   ├── dedup.ts          # normalizeTitle, sha256Prefix, AI-output validators
│   │   └── categories.ts     # the 8 canonical categories + alias enforcement
│   └── lib/
│       ├── db.ts             # D1 helpers (chunked IN, batched inserts, log)
│       ├── kv.ts             # typed KV helpers, cache get/put/delete-by-prefix
│       ├── types.ts          # Env, TopicCoverageMap, ApiCard, PipelineResult, ...
│       └── cors.ts           # CORS headers + JSON response helpers
├── wrangler.jsonc            # bindings, cron, vars
├── schema.sql                # D1 schema (plan §4)
├── seed/seed-map.json        # initial topic-coverage-map (plan §2.1, v1, empty)
├── test/                     # vitest unit tests (pure logic)
└── .dev.vars.example         # local-dev secrets template
```

## Development

```bash
cd workers
npm install
npx wrangler types        # regenerate worker-configuration.d.ts after config changes
npx tsc --noEmit          # type gate (deploy --dry-run does NOT type-check)
npx vitest run            # unit tests
npx wrangler deploy --dry-run --outdir=dist   # bundle check
```

Local end-to-end run (uses `.dev.vars`, local D1/KV simulators):

```bash
cp .dev.vars.example .dev.vars      # then fill in OPENROUTER_API_KEY / ADMIN_SECRET
npx wrangler d1 execute my-stash-cards --local --file=./schema.sql
npx wrangler kv key put topic-coverage-map --path=seed/seed-map.json --local
npx wrangler dev
```

When changing `wrangler.jsonc`, rerun `npx wrangler types` (CI habit:
`wrangler types --check` fails on stale generated types).

Local CORS: with `CORS_ORIGIN` unset the API answers `Access-Control-Allow-Origin: *`,
which covers most local browser use. To restrict it, uncomment the
`CORS_ORIGIN` line in `.dev.vars` and set your frontend origin (e.g.
`http://localhost:3000`); comma-separate multiple origins.

## Deployment runbook

Run from `workers/`. Replace the three placeholders in `wrangler.jsonc` first:
`account_id` (`npx wrangler whoami`), `database_id` (step 1), KV `id` (step 2).

1. Create the D1 database:

   ```bash
   npx wrangler d1 create my-stash-cards
   # copy database_id into wrangler.jsonc
   ```

2. Create the KV namespace (binding name is `KV`):

   ```bash
   npx wrangler kv namespace create KV
   # copy the namespace id into wrangler.jsonc
   ```

3. Apply the D1 schema (remote). Fresh applies only — `schema.sql` includes
   the `idx_log_running_per_day` partial unique index (the concurrent-run
   lock, see deviations); the project is not yet deployed, so there is no
   existing database to migrate:

   ```bash
   npx wrangler d1 execute my-stash-cards --remote --file=./schema.sql
   ```

4. Set the secrets:

   ```bash
   npx wrangler secret put OPENROUTER_API_KEY
   npx wrangler secret put ADMIN_SECRET
   ```

5. Seed the topic coverage map in KV:

   ```bash
   npx wrangler kv key put topic-coverage-map --path=seed/seed-map.json --namespace-id=<KV_NAMESPACE_ID>
   ```

6. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

7. Trigger the first batch manually:

   ```bash
   curl -X POST https://my-stash-api.workers.dev/api/generate \
     -H "Authorization: Bearer $ADMIN_SECRET"
   # -> 202 {"status":"queued","batchDate":"2026-09-25"}
   # the */15 cron poller picks the run up within <= 15 minutes; poll:
   curl https://my-stash-api.workers.dev/api/stats
   ```

   While cron events are not being delivered for this worker (see deviation
   #18), the poller never fires — trigger the batch synchronously instead:

   ```bash
   curl -X POST https://my-stash-api.workers.dev/api/run-sync \
     -H "Authorization: Bearer $ADMIN_SECRET"
   # -> 200 {"status":"completed","batchDate":"2026-09-25",...} after ~90 s
   ```

   An empty body uses the daily default (2 cards per category, 16 total);
   `{ "requested": n }` overrides it (clamped 1–50).

8. Point the frontend at the Worker: set
   `NEXT_PUBLIC_API_URL=https://my-stash-api.workers.dev` in the Pages
   environment and redeploy Pages.

9. Verify the cron (`0 5 * * *`, 05:00 UTC) next day via the Workers
   dashboard -> Triggers, or by checking `wrangler tail` output and
   `GET /api/stats` (`totalBatches` should increment).

## API

| Route | Auth | Cache |
|---|---|---|
| `GET /api/cards?page&limit&category&tag&date` | public | KV 1h per param combo (`api-cache:cards:<hash>`), `Cache-Control: public, max-age=3600` |
| `GET /api/cards/today` | public | KV 6h (`api-cache:today`, invalidated by the pipeline), `Cache-Control: public, max-age=300, stale-while-revalidate=21000` |
| `GET /api/stats` | public | none server-side, `max-age=300` |
| `POST /api/generate` | `Authorization: Bearer $ADMIN_SECRET` | `no-store` |
| `POST /api/run-sync` | `Authorization: Bearer $ADMIN_SECRET` | `no-store` |

Notes:

- `/api/cards`: `page >= 1`, `limit` default 20 clamped to 1–50, `date` must be
  `YYYY-MM-DD` (otherwise ignored). Tag filtering uses
  `EXISTS (SELECT 1 FROM json_each(generated_cards.tags) ...)`.
- `/api/cards/today`: if today's batch has no cards yet (before the first cron
  fires), it degrades gracefully and returns the most recent batch that has
  cards, with `batchDate` telling the client which batch it got.
- `POST /api/generate` body is optional; `{ "requested": n }` clamps 1–50 and
  defaults to the daily target of 2 cards per canonical category (16 total).
  If today already produced cards (`success`, or `partial` with
  `generated > 0` in `generation_log`), it returns
  `200 {"status":"already_completed", ...}` and nothing is queued; a day with
  zero cards (`failed`, or a 0-card `partial`) can be retried. Otherwise it
  returns `202 {"status":"queued","batchDate":"<today>"}` — the request is
  written to the `run_requests` D1 table and the `*/15 * * * *` cron poller
  consumes it (oldest first) and runs the pipeline inside a cron invocation's
  15-minute budget, so a manual run lands **within at most 15 minutes**, not
  immediately. The daily 05:00 cron is unchanged. If another run (cron or
  admin) is already in flight, the pipeline skips itself with
  `status: "skipped", reason: "lock-held"` — a partial UNIQUE index on
  `generation_log(batch_date) WHERE status = 'running'` enforces one run per
  day, and locks whose isolate died are swept after 30 minutes. (Why queued
  instead of started: see deviations #17.)
- `POST /api/run-sync` is the synchronous twin of `POST /api/generate` (same
  bearer auth, same optional `{ "requested": n }` body): it AWAITS the
  pipeline inline and only responds when the batch is done (~90 s — keep the
  client timeout generous). Returns `200 {"status":"completed", ...}` with the
  pipeline's counts, `200 {"status":"already_completed", ...}` when the day
  was already done or another run holds the D1 lock, and
  `502 {"error":"generation_failed", ...}` when the run failed or crashed
  (the attempt is already logged in `generation_log`; a failed day stays
  retryable). It exists because cron events are currently not delivered for
  this worker — see deviation #18.
- Cron triggers are `["0 5 * * *", "*/15 * * * *"]`: the daily batch, plus the
  poller that executes queued manual runs. Both fire at 05:00:00; the D1 run
  lock turns that overlap into a no-op skip for the second fire (it only
  warns — no rows are written). Currently, however, no cron events are being
  delivered at all (registered but zero scheduled events observed — see
  deviation #18), so `POST /api/run-sync` is the working execution path until
  delivery resumes.
- When `OPENROUTER_API_KEY` is unset, the read endpoints keep working; only
  generation returns `503 {"error":"generation not configured"}` (see
  deviations).
- 404s return `{"error":"not_found"}`; known paths with wrong methods return
  405. All responses carry CORS headers from `CORS_ORIGIN`
  (`Access-Control-Allow-Headers: Authorization, Content-Type`).
  `CORS_ORIGIN` may be a comma-separated allowlist: an `Origin` matching an
  entry is echoed back (with `Vary: Origin`), a non-allowlisted browser
  origin gets no `Access-Control-Allow-Origin` at all, and requests without
  an `Origin` header (curl/cron) get the first entry. When the var is
  unset/empty it falls back to `*`.

## Model id caveat

The plan mandates `openai/gpt-luna-latest`, which could not be verified on
OpenRouter (404 on the model page; sibling `openai/gpt-5.6-luna` IS verified).
It is kept as the default value of the `OPENROUTER_MODEL` var exactly as the
plan says. Everything reads the var, so if the first run 404s, switch with one
line in `wrangler.jsonc`:

```jsonc
"OPENROUTER_MODEL": "openai/gpt-5.6-luna"
```

then `npx wrangler deploy`.

### Reasoning tokens count against `max_completion_tokens`

The model above is a **reasoning model**: before (and while) writing its
answer it spends hidden reasoning tokens, and OpenRouter caps AND bills those
as part of `max_completion_tokens`. Production observed
`finish_reason: "length"` with `usage: {completion_tokens: 4000,
reasoning_tokens: 1404}` — leaving only ~2,600 tokens of actual JSON and
cutting the response mid-object. The per-call caps in `ai-client.ts` are
therefore sized as visible output + reasoning headroom (~1,400 tokens typical,
can spike):

| Call site (`pipeline.ts`)            | Visible-output estimate                       | Cap     |
|--------------------------------------|-----------------------------------------------|---------|
| Title generation (24 titles)         | 24 title objects x ~70 tokens ≈ 1,700         | 10,000  |
|                                      | (quota + 1 per category; ~4,500 at manual 50) |         |
| Near-duplicate filter                | echoes ~24 short candidates + small verdict   |  4,000  |
| Card expansion (10 cards)            | 10 cards x 80–150 words ≈ 2,500–3,500 tokens  |  8,000  |
| Map update                           | echoes the full coverage map + merged output  |  8,000  |

`callAIJson` is additionally self-correcting: if a response fails to
parse/validate and `finish_reason` was `"length"`, it retries once at double
the cap (same messages, hard ceiling 32,000) before the existing
stricter-prompt retry; if every attempt still fails, the thrown error mentions
`finish_reason=length` so the generation log stays diagnosable.

## Deviations from the plan (and why)

1. **`wrangler.jsonc` instead of `wrangler.toml`** — Cloudflare's
   recommendation for new projects; TOML still works.
2. **KV binding named `KV`** (plan §14 draft used `MY_STASH_KV`) — matches the
   brief and `wrangler kv namespace create KV`.
3. **`max_completion_tokens` instead of `max_tokens`** — the latter is
   deprecated upstream.
4. **HTTP-200-with-error-body handling** — OpenRouter can return
   `200 { "error": { code, message } }` on provider failure; `ai-client.ts`
   checks the body error object on every response, not just the status code,
   and retries it when the code is retryable.
5. **`recentTopicSlugs` extension field on the topic map** (cap 50, refreshed
   to the last inserted slugs each batch) — gives the near-dedup prompt a
   deterministic "recently covered" list instead of relying on JSON key order.
   The seed file and `DEFAULT_TOPIC_MAP` include it; older maps without it
   still load (validator defaults it to `[]`).
6. **Deterministic local map-merge fallback** — if the AI map merge fails or
   returns an invalid map (old entries dropped, version not bumped, new slugs
   missing), a pure local merge does exactly what `MAP_UPDATE_PROMPT` asks.
   Cards are already committed at that point; the map update must not fail the
   batch. Deterministic fields (`totalCards`, `recentTopicSlugs`, `updatedAt`)
   are always recomputed locally, even on the AI path.
7. **"Retry in 1 hour via `setTimeout`" (plan §13) replaced by immediate
   in-pipeline retry + `partial` status** — Workers have no timers beyond the
   invocation, so there is no hourly timer. The AI client retries transient
   failures inside the run (3x backoff), unparseable JSON once with a
   stricter prompt, and a truncated response (`finish_reason=length`) once at
   a doubled cap — see "Reasoning tokens" above. A day that produced ZERO
   cards (`failed`, or a 0-card
   `partial`) is retryable the same day — the guard only blocks days that
   actually have cards.
8. **Read endpoints stay up when `OPENROUTER_API_KEY` is missing** — plan §13
   says 503 on all routes; per PM decision only generation routes return 503,
   so `/api/cards`, `/api/cards/today` and `/api/stats` keep serving the
   already-generated corpus.
9. **Guard treats a day WITH cards as done** — `success` rows and `partial`
   rows with `generated > 0` block a re-run (no double-generate); a `failed`
   row and a 0-card `partial` row allow retry, so a day that generated nothing
   is never permanently un-retryable. D1 (strongly consistent) is the
   authoritative guard; KV is only a cache (eventual consistency, ~60s).
10. **`INSERT OR IGNORE` written as `ON CONFLICT(title_hash) DO NOTHING`** —
    same SQLite semantics, explicit conflict target. Inserts go through
    transactional `db.batch()` chunks of 50 (counted from `meta.changes`);
    D1 IN-lookups are chunked at 90 params (hard limit 100).
11. **`/api/cards/today` falls back to the latest batch with cards** when
    today has none yet — nicer first-day behavior than an empty 200.
12. **Placeholders must be replaced before deploy**: `account_id`,
    `database_id`, and the KV namespace `id` in `wrangler.jsonc` are
    `REPLACE_WITH_*` sentinels; the runbook above fills them in.
13. **Strongly-consistent D1 run lock** — a partial UNIQUE index,
    `idx_log_running_per_day` on `generation_log(batch_date) WHERE status =
    'running'`, makes a concurrent cron + admin double-run impossible: each
    run inserts its `running` row (INSERT OR IGNORE) at start and UPDATEs that
    same row to its final status at completion, so a run never leaves two rows
    behind and a crashed run ends `failed` (retryable), never stranded as
    `running` — except when the isolate itself dies, which the 30-minute
    stale-lock sweep covers. `changes = 0` on the insert means another run
    holds the lock and the run is skipped (`reason: 'lock-held'`). KV is
    eventually consistent and deliberately not used for this. Schema addition
    applies to fresh databases only; the project is not yet deployed, so no
    migration is needed.
14. **`/api/cards/today` browser cache shortened** — plan §7 says "cached in
    KV for 6 hours"; the KV TTL stays 21600 s (the pipeline invalidates that
    key after each batch), but the BROWSER `Cache-Control` is now
    `public, max-age=300, stale-while-revalidate=21000` — a 6 h browser cache
    kept serving stale cards all day after a batch landed, because the browser
    never revalidated.
15. **`CORS_ORIGIN` accepts a comma-separated allowlist** — an `Origin`
    matching an entry is echoed back with `Vary: Origin`; a non-allowlisted
    browser origin gets no `Access-Control-Allow-Origin` header (the browser
    blocks it); requests without an `Origin` header get the first entry; a
    single configured origin behaves exactly as before, and an unset var still
    falls back to `*`.
16. **AI map merges are capped** — an AI-merged map holding more than
    `existingTotal + newTopics.length + 10` slugs (counted across all
    categories/subcategories) is rejected in favor of the deterministic local
    merge, guarding against runaway invented slugs.
17. **`POST /api/generate` responds `202 {"status":"queued", ...}` instead of
    the plan's `{"status":"started", ...}` and runs from a cron, not from
    `ctx.waitUntil`** — the plan (§7) fires the pipeline via
    `ctx.waitUntil(pipeline())` off the HTTP fetch event. Production showed
    that does not survive contact with the real runtime: waitUntil promises on
    an HTTP fetch event are killed ~30 seconds after the response is sent,
    while the pipeline takes ~77 s (measured locally — local `wrangler dev`
    does NOT enforce the ceiling, which is why it passed there). The isolate
    died mid-run and left a stranded `'running'` row in `generation_log` with
    zero cards. Cron invocations get a 15-minute wall-time budget, so manual
    runs are now queued in a `run_requests` D1 table and executed by a new
    `*/15 * * * *` poller cron (claim-before-run: the row is deleted before the
    pipeline starts, so a failed attempt is recorded in `generation_log`
    instead of dangling in the queue). The daily 05:00 batch is unchanged; when
    both crons fire together at 05:00:00, the D1 run lock makes the second
    fire a `lock-held` skip that writes nothing.
18. **Cron triggers are registered, but no cron events are being delivered;
    `POST /api/run-sync` added as the synchronous execution path** — on the
    deployed worker both triggers were registered correctly, yet 10+ minutes
    of `wrangler tail` showed zero `scheduled` invocations while ordinary
    HTTP requests kept flowing (an every-minute trigger was added as a
    diagnostic and produced no events either — the platform is not delivering
    cron events for this worker at all; investigation ongoing). Until
    delivery resumes, neither the 05:00 batch nor #17's poller can execute
    anything, so `/api/run-sync` runs the pipeline synchronously inside the
    HTTP request: same admin bearer auth and optional `{ "requested": n }`
    body as `/api/generate`, but it awaits `runGeneration` and returns the
    outcome — `200 {"status":"completed", ...}`, `200
    {"status":"already_completed", ...}` when the guard/lock skipped the run,
    or `502 {"error":"generation_failed", ...}` when it failed or crashed.
    Inlining is safe even though #17 showed post-response `waitUntil` is
    killed at ~30 s: that ceiling applies only to promises still running
    AFTER the response — an in-flight awaited request keeps the isolate alive
    with no such ceiling, and the pipeline is I/O-bound (~90 s wall, ~0 ms
    CPU, well under the free tier's 10 ms CPU cap). Concurrent or duplicate
    invocations stay safe without the queue: the D1 run lock (#13) plus the
    idempotency guard make every loser a `lock-held`/`already_completed`
    no-op. The crons remain registered and dormant-safe — the queue/poller
    machinery is untouched (its diagnostic every-minute cadence was reverted
    to `*/15`), and both resume automatically if delivery resumes:

    ```bash
    curl -X POST https://my-stash-api.workers.dev/api/run-sync \
      -H "Authorization: Bearer $ADMIN_SECRET"
    # -> 200 {"status":"completed","batchDate":"<today>",...} after ~90 s
    ```
20. **Daily batch retargeted from 50 free-distributed cards to 2 per canonical
    category per day (16/day)** — 2026-09-26 product-owner spec change. The
    plan asked the title AI for 60 candidates and took the first 50 whatever
    categories they happened to land in; the owner now wants an even spread:
    `CARDS_PER_CATEGORY_PER_DAY = 2` per each of the 8 canonical categories,
    so `DEFAULT_DAILY_REQUESTED` = 16 is the daily default (admin endpoints
    and the cron fallback both read it), while the manual
    `{ "requested": n }` override keeps its 1–50 clamp. Three mechanisms
    deliver the spread: (a) `TITLE_GENERATION_PROMPT` states an explicit
    per-category quota — `ceil(requested / 8) + 1` candidates per category
    (3 per category / 24 titles total for the default 16) — replacing the
    fixed 60-title ask and keeping a per-category surplus like the old
    60-for-50 one; (b) selection replaces the global `slice(0, requested)`
    with a per-category round-robin (`selectAcrossCategories`): a first pass
    takes up to the quota per category in canonical order, then top-up rounds
    draw from each category's remaining surplus so a category whose candidates
    were all dropped or deduplicated lets the others fill the gap — round-robin
    also handles a `requested` that is not divisible by 8; (c) a category that
    contributed nothing is surfaced as a run warning ("no titles selected for
    N of the 8 categories (…names…)"). Title quality ordering is unchanged
    (model order, take-earliest per category), and the 'success' threshold
    (`generated >= requested * 0.8`) now evaluates against 16.
19. **Canonical categories are hard-enforced at title-candidate validation** —
    the plan never constrains the `category` string the title AI stamps on
    each candidate, and the 2026-09-26 production run showed what that costs:
    9 off-schema cards landed (6 "Technology", 2 "History", 1 "Philosophy").
    The 6 Technology cards were remapped to Tech in place by SQL; the 3
    History/Philosophy cards were intentionally LEFT as published — content
    quality over schema purity for already-visible cards (PM decision). The
    pipeline now trusts nothing: the plan's 8 categories live once in
    `src/generation/categories.ts` (`CANONICAL_CATEGORIES`); every candidate
    is alias-normalized case-insensitively (`Technology` → `Tech`, plus the
    plan's own "Health" / "Leadership" / "Communication" shorthands from the
    §12 tag lists and the §7 example output) with the canonical spelling
    written back, and anything still non-canonical is DROPPED before the
    dedup steps and the selection cut — the title prompt's surplus quota
    absorbs the loss (#20 later made that surplus per-category), and no
    expansion AI calls are spent on doomed candidates. Each
    drop is surfaced as a run warning ("dropped N title(s) with
    non-canonical categories (…names…)"). The free-text `subcategory` field
    is deliberately untouched — only categories are enumerated.
