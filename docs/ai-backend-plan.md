# My Stash — AI Generation Backend: Implementation Plan

**Document:** `docs/ai-backend-plan.md`  
**Date:** 2026-09-25  
**Status:** Draft — ready for implementation

---

## 1. Goal & Scope

Add a server-side AI generation pipeline that automatically produces **50 new microlearning cards per day** across all topic categories (not just business). Cards are stored in a persistent database, deduplicated intelligently without blowing out the AI context window, and exposed via a REST API that the existing static Next.js frontend can query on load.

**Constraints inherited from the existing app:**
- Frontend is a Cloudflare Pages static export — no Node.js runtime.
- All new server-side code must run on **Cloudflare Workers** (V8 isolate runtime, no Node APIs).
- AI calls go through **OpenRouter** using model `openai/gpt-luna-latest`.
- No auth required for v1 — the API is read-only for the public and write-only via a cron trigger or a secret-gated admin route.

---

## 2. The Core Problem: Deduplication Without Context Overflow

Naïvely listing every previously generated card title in each new prompt fails at scale. With 50 cards/day, after just 40 days there are 2,000 titles in the prompt — well past practical context limits and economically wasteful.

### 2.1 Solution: The Topic Coverage Map

Instead of sending raw card data to the AI, maintain a **compact hierarchical topic map** in Cloudflare KV. This map records *which idea territory has been covered*, not the full card text. It grows slowly and predictably.

**Structure (stored as JSON in KV under key `topic-coverage-map`):**

```json
{
  "version": 12,
  "updatedAt": "2026-10-04T06:15:00Z",
  "totalCards": 500,
  "categories": {
    "Mindset": {
      "Cognitive Biases": ["loss aversion", "confirmation bias", "dunning-kruger effect", "sunk cost fallacy"],
      "Mental Models": ["inversion principle", "first principles thinking", "occam's razor", "second-order thinking"],
      "Habits & Identity": ["habit loop", "identity-based habits", "compound effect", "temptation bundling"]
    },
    "Productivity": {
      "Time Management": ["parkinson's law", "time blocking", "eisenhower matrix", "pomodoro technique"],
      "Focus & Deep Work": ["deep work", "flow state", "attention residue", "single-tasking"],
      "Systems": ["gtd methodology", "zettelkasten", "kanban boards"]
    },
    "Finance": {
      "Investing": ["compounding returns", "index fund strategy", "dollar-cost averaging"],
      "Behavioral Finance": ["market timing fallacy", "diversification", "risk-adjusted returns"],
      "Personal Finance": ["pay yourself first", "emergency fund rule", "opportunity cost"]
    },
    "Tech": {
      "Software Design": ["occam's razor in code", "separation of concerns", "yagni principle"],
      "AI & Automation": ["prompt engineering basics", "automation bias"],
      "Security": ["zero trust model", "principle of least privilege"]
    },
    "Creativity": {
      "Idea Generation": ["lateral thinking", "constraints as catalysts", "bisociation"],
      "Creative Process": ["incubation phase", "divergent vs convergent thinking"]
    },
    "Health & Wellbeing": {
      "Sleep": [],
      "Exercise": [],
      "Nutrition": []
    },
    "Leadership & Communication": {
      "Negotiation": [],
      "Feedback": [],
      "Storytelling": []
    }
  }
}
```

**Why this works:**
- Max size is ~5–8 KB regardless of how many total cards exist — it's a *topic index*, not a card list.
- The AI sees *what territory is covered* and is explicitly told to pick uncovered or under-covered subtopics.
- New categories (e.g., `"Health & Wellbeing"`) can be seeded as empty arrays to guide the AI toward them.
- After each batch, the AI itself updates the map with newly covered topic slugs — the AI is responsible for both generation *and* map maintenance.

### 2.2 Hard Deduplication: Title Hash Index

Topic map is "soft" dedup (semantic). For hard dedup, store a normalized title hash in D1:

```
normalized_title = title.lower().trim().replace(/\s+/g, ' ')
title_hash = sha256(normalized_title).slice(0, 16)  // 64-bit prefix
```

Before inserting a generated card, check if `title_hash` exists in D1. Collisions are astronomically unlikely; exact and near-exact title matches will always be caught.

### 2.3 Near-Duplicate Detection via AI Pre-Filter

As an additional layer, before expanding titles into full cards, the Worker sends the batch of **proposed titles** (from step 1) along with the last **50 title slugs from the topic map** to the AI and asks it to flag any that are too similar to existing ones. This catches paraphrased duplicates:

> *"Leverage Effect"* vs *"Financial Leverage"* — caught here, not after expensive full-card generation.

This is the only place existing content enters the prompt, and it's capped at 50 slugs (always the same size).

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                  │
│                                                             │
│  ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │  Cloudflare     │    │  Cloudflare Worker           │   │
│  │  Pages          │    │  (my-stash-api)              │   │
│  │  (static app)   │◄───┤                              │   │
│  │                 │    │  Routes:                     │   │
│  │  Next.js SSG    │    │  GET  /api/cards             │   │
│  │  ─ localStorage │    │  GET  /api/cards/today       │   │
│  │  ─ fetch()      │    │  GET  /api/stats             │   │
│  └─────────────────┘    │  POST /api/generate (admin)  │   │
│                         │                              │   │
│                         │  Cron: daily at 05:00 UTC    │   │
│                         └──────┬──────┬───────────────┘   │
│                                │      │                    │
│               ┌────────────────┘      └──────────────┐    │
│               ▼                                       ▼    │
│  ┌────────────────────┐              ┌─────────────────────┐│
│  │  Cloudflare D1     │              │  Cloudflare KV      ││
│  │  (SQLite)          │              │                     ││
│  │                    │              │  topic-coverage-map ││
│  │  • generated_cards │              │  generation-state   ││
│  │  • generation_log  │              │  api-cache:{date}   ││
│  │  • title_hashes    │              │                     ││
│  └────────────────────┘              └─────────────────────┘│
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │  OpenRouter API     │
                   │  openai/gpt-luna-  │
                   │  latest             │
                   └─────────────────────┘
```

### Components

| Component | Technology | Purpose |
|---|---|---|
| API + Cron Worker | Cloudflare Workers | REST API + daily generation trigger |
| Card Database | Cloudflare D1 (SQLite) | Persistent storage for generated cards |
| Topic Map + Cache | Cloudflare KV | Compact dedup state + response cache |
| AI Provider | OpenRouter (`openai/gpt-luna-latest`) | Card generation |
| Static Frontend | Cloudflare Pages (existing) | Serves the Next.js app |

---

## 4. D1 Database Schema

```sql
-- cards/schema.sql

CREATE TABLE IF NOT EXISTS generated_cards (
  id            TEXT    PRIMARY KEY,          -- uuid v4
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,             -- markdown-lite
  source        TEXT    NOT NULL DEFAULT '',
  tags          TEXT    NOT NULL DEFAULT '[]',-- JSON string array
  category      TEXT    NOT NULL,             -- top-level category
  subcategory   TEXT    NOT NULL DEFAULT '',
  topic_slug    TEXT    NOT NULL,             -- kebab-case normalized topic id
  title_hash    TEXT    NOT NULL,             -- sha256 prefix for dedup
  batch_date    TEXT    NOT NULL,             -- YYYY-MM-DD
  created_at    TEXT    NOT NULL,             -- ISO datetime
  word_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (title_hash)
);

CREATE INDEX IF NOT EXISTS idx_batch_date  ON generated_cards(batch_date);
CREATE INDEX IF NOT EXISTS idx_category    ON generated_cards(category);
CREATE INDEX IF NOT EXISTS idx_created_at  ON generated_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title_hash  ON generated_cards(title_hash);

CREATE TABLE IF NOT EXISTS generation_log (
  id              TEXT    PRIMARY KEY,        -- uuid v4
  batch_date      TEXT    NOT NULL,           -- YYYY-MM-DD
  requested       INTEGER NOT NULL,
  generated       INTEGER NOT NULL,
  duplicates_skip INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  model           TEXT    NOT NULL,
  status          TEXT    NOT NULL,           -- 'success' | 'partial' | 'failed'
  error           TEXT,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_date ON generation_log(batch_date);
```

> **Note:** No `review_count`, `favorite`, `lastReviewedAt` — those are user-state fields that live in the frontend's `localStorage`. The backend only stores the canonical card content.

---

## 5. Cloudflare Worker: File Structure

```
workers/
├── src/
│   ├── index.ts              # Worker entry — routes + cron handler
│   ├── routes/
│   │   ├── cards.ts          # GET /api/cards, GET /api/cards/today
│   │   ├── stats.ts          # GET /api/stats
│   │   └── admin.ts          # POST /api/generate (secret-gated)
│   ├── generation/
│   │   ├── pipeline.ts       # Orchestrates the full daily generation
│   │   ├── topic-map.ts      # Read/write/update the topic coverage map
│   │   ├── ai-client.ts      # OpenRouter fetch wrapper
│   │   ├── prompts.ts        # All prompt templates (single source of truth)
│   │   └── dedup.ts          # Title hashing + D1 dedup check
│   └── lib/
│       ├── db.ts             # D1 query helpers
│       ├── kv.ts             # KV read/write helpers
│       ├── types.ts          # Shared TypeScript types
│       └── cors.ts           # CORS headers for Pages → Worker requests
├── wrangler.toml             # Worker config (bindings, cron, routes)
├── schema.sql                # D1 schema (applied via wrangler d1 execute)
└── package.json
```

---

## 6. The Daily Generation Pipeline (Step by Step)

Triggered by the cron at 05:00 UTC (or `POST /api/generate` with admin secret):

### Step 1 — Guard: Already ran today?

```typescript
const today = new Date().toISOString().slice(0, 10); // "2026-10-05"
const existing = await db
  .prepare("SELECT generated FROM generation_log WHERE batch_date = ? AND status = 'success'")
  .bind(today)
  .first();

if (existing) return; // idempotent — skip if today already done
```

### Step 2 — Load Topic Coverage Map

```typescript
const mapJson = await env.KV.get("topic-coverage-map");
const topicMap: TopicCoverageMap = mapJson
  ? JSON.parse(mapJson)
  : DEFAULT_TOPIC_MAP; // seed map with empty categories
```

### Step 3 — Generate 60 Title Candidates (Ask for 20% extra buffer)

Send a single AI call with the compact topic map. Ask for 60 titles in JSON format to have slack for dedup rejections:

```
SYSTEM:
You are a microlearning content curator. Generate diverse, insightful idea titles for
a "My Stash" app. Each title represents a concept someone can learn in 2–3 minutes.
Respond ONLY with valid JSON — no markdown, no prose.

USER:
Generate exactly 60 unique microlearning card titles.

RULES:
- Cover a WIDE variety of topics: mindset, productivity, finance, tech, creativity,
  health, leadership, science, philosophy, history, communication, negotiation, design.
- DO NOT repeat or closely paraphrase any topic already in the coverage map below.
- Prefer under-covered categories (those with fewer items listed).
- Format: { "titles": [{ "title": "...", "category": "...", "subcategory": "...", "topic_slug": "..." }] }

COVERAGE MAP (what has already been covered — avoid these):
<topic_map_json>
```

**Token budget:** The coverage map JSON is ~3–8 KB (a few hundred tokens). Well within any model's context.

### Step 4 — Hard Dedup: Title Hash Check

```typescript
const candidates = aiResponse.titles;
const hashes = candidates.map(t => sha256Prefix(normalize(t.title)));

// Batch query D1 for existing hashes
const placeholders = hashes.map(() => '?').join(',');
const existing = await db
  .prepare(`SELECT title_hash FROM generated_cards WHERE title_hash IN (${placeholders})`)
  .bind(...hashes)
  .all();

const existingSet = new Set(existing.results.map(r => r.title_hash));
const unique = candidates.filter(t => !existingSet.has(sha256Prefix(normalize(t.title))));
// unique now has 50–60 items (some may be filtered)
```

### Step 5 — AI Near-Duplicate Filter

Take `unique` titles + last 50 topic slugs from the map. Ask AI to remove near-duplicates:

```
SYSTEM: You are a deduplication filter. Respond ONLY with JSON.

USER:
From the CANDIDATE list below, remove any title that is semantically too similar to
an item in the EXISTING list. Return titles that are genuinely different concepts.

EXISTING (recently covered topic slugs — 50 max):
["loss-aversion", "compounding-returns", "parkinson-s-law", ...]

CANDIDATES:
[{"title": "The Leverage Effect", ...}, {"title": "Loss Aversion in Investing", ...}, ...]

Respond: { "approved": [<subset of candidates that are not near-duplicates>] }
```

This call is cheap (short input/output) and catches paraphrased duplicates.

### Step 6 — Expand Approved Titles into Full Cards (Batch)

Take the first 50 approved titles and expand them. To avoid N×50 individual AI calls (expensive and slow), send them **in batches of 10** to the AI in a single call each:

```
SYSTEM:
You are a microlearning card writer. Write insightful, actionable cards.
Respond ONLY with valid JSON.

USER:
Expand each of the following titles into a full microlearning card.

FORMAT for each card:
{
  "title": "...",
  "body": "...", // 80–150 words, markdown-lite only (**bold**, *italic*, - lists)
  "source": "...", // real book, paper, or person — never invented
  "tags": ["...", "..."] // 1–3 from: Mindset, Productivity, Finance, Tech, Creativity, Health, Leadership
}

TITLES TO EXPAND:
1. The Dunning-Kruger Effect
2. Zeigarnik Effect
...10 titles
```

5 batches × 10 titles = 5 AI calls for all 50 cards. Each call is independent and can be run in parallel with `Promise.all`.

### Step 7 — Validate & Insert

```typescript
for (const card of expandedCards) {
  const wordCount = countWords(card.body);
  if (wordCount < 50 || wordCount > 200) continue; // sanity guard
  if (!card.title || !card.body) continue;

  await db.prepare(`
    INSERT OR IGNORE INTO generated_cards
    (id, title, body, source, tags, category, subcategory, topic_slug,
     title_hash, batch_date, created_at, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    card.title, card.body, card.source,
    JSON.stringify(card.tags),
    candidate.category, candidate.subcategory, candidate.topic_slug,
    sha256Prefix(normalize(card.title)),
    today, new Date().toISOString(),
    wordCount
  ).run();
}
```

`INSERT OR IGNORE` means if two parallel batches happen to generate the same title, the second insert is a no-op — safe by design.

### Step 8 — Update Topic Coverage Map

Send the newly added topic slugs to AI and ask it to merge them into the existing map:

```
SYSTEM: Update the topic coverage map JSON. Return ONLY the updated JSON object.

USER:
Current map: <existing map JSON>

New topics to add (merge into correct categories):
[{"category": "Mindset", "subcategory": "Cognitive Biases", "slug": "dunning-kruger-effect"}, ...]

Return the updated map with new slugs added to their subcategories.
Keep existing entries. If a subcategory doesn't exist yet, create it.
```

Store result back to KV.

### Step 9 — Log the Batch

```typescript
await db.prepare(`
  INSERT INTO generation_log
  (id, batch_date, requested, generated, duplicates_skip, duration_ms, model, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  crypto.randomUUID(), today,
  50, insertedCount, skippedCount,
  Date.now() - startTime,
  'openai/gpt-luna-latest', 'success',
  new Date().toISOString()
).run();
```

### Step 10 — Invalidate API Cache

```typescript
await env.KV.delete(`api-cache:${today}`);
await env.KV.delete('api-cache:latest');
```

---

## 7. API Endpoints

### `GET /api/cards`

Paginated list of all AI-generated cards.

**Query params:** `page` (default 1), `limit` (default 20, max 50), `category`, `tag`, `date` (YYYY-MM-DD)

**Response:**
```json
{
  "cards": [
    {
      "id": "uuid",
      "title": "The Dunning-Kruger Effect",
      "body": "...",
      "source": "Kruger & Dunning, 1999",
      "tags": ["Mindset"],
      "category": "Mindset",
      "subcategory": "Cognitive Biases",
      "createdAt": "2026-10-05T05:15:00Z",
      "batchDate": "2026-10-05"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 842, "pages": 43 }
}
```

**Cache strategy:** KV-cached for 1 hour per `(page, category, tag, date)` combination.

### `GET /api/cards/today`

Returns all cards generated in today's batch. Cached in KV for 6 hours.

### `GET /api/stats`

```json
{
  "totalCards": 842,
  "totalBatches": 17,
  "lastBatchDate": "2026-10-05",
  "lastBatchGenerated": 50,
  "categoryBreakdown": {
    "Mindset": 142,
    "Productivity": 128,
    "Finance": 95,
    "Tech": 112,
    "Creativity": 89,
    "Health": 56,
    "Leadership": 72,
    "Other": 148
  },
  "topicMapVersion": 12
}
```

### `POST /api/generate` (admin-only)

Manually triggers the generation pipeline. Protected by `Authorization: Bearer <ADMIN_SECRET>` header (secret set in Worker environment variables / Wrangler secrets).

```json
{ "requested": 50 }
```

Response: `{ "status": "started", "batchDate": "2026-10-05" }`

> Returns immediately; generation runs asynchronously via `ctx.waitUntil(pipeline())`.

---

## 8. `wrangler.toml` Configuration

```toml
name = "my-stash-api"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "my-stash-cards"
database_id = "<your-d1-db-id>"

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["0 5 * * *"]    # 05:00 UTC every day

[vars]
OPENROUTER_MODEL = "openai/gpt-luna-latest"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
CORS_ORIGIN = "https://my-stash.pages.dev"   # your Pages domain

# Set via: wrangler secret put OPENROUTER_API_KEY
# Set via: wrangler secret put ADMIN_SECRET
```

---

## 9. CORS Strategy

The static frontend on `my-stash.pages.dev` calls the Worker on `my-stash-api.workers.dev`. All API responses include:

```
Access-Control-Allow-Origin: https://my-stash.pages.dev
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Max-Age: 86400
```

The admin `POST /api/generate` route additionally checks the `Authorization` header.

---

## 10. Frontend Integration

The existing static app gets a new **"Discover"** section that fetches from the Worker API on load and merges AI-generated cards into the browsing experience.

### Fetch strategy (client-side)

```typescript
// src/lib/api.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function fetchTodayCards(): Promise<Card[]> {
  if (!API_BASE) return []; // graceful degradation
  try {
    const res = await fetch(`${API_BASE}/api/cards/today`, {
      next: { revalidate: 3600 } // browser cache hint
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.cards.map(mapApiCardToLocalCard);
  } catch {
    return []; // network error → silent fallback to localStorage-only mode
  }
}
```

### UI changes required

1. Add `source: "ai"` flag to the local `Card` type to distinguish AI cards from user-created ones.
2. In the Filter Bar, add a **"✨ AI Daily"** pill that filters to today's AI-generated batch.
3. On app load, `AppProvider` fetches today's cards from the API and merges them into `state.data.cards` (not persisted to `localStorage` — re-fetched on each load).
4. AI cards render identically to user cards but show a subtle "✨ AI generated" badge in the card footer.
5. User-created card interactions (favorite, stash, edit, delete) still work on AI cards and are tracked in `localStorage` as normal.

### Environment variable

Add to `.env.local` and Cloudflare Pages environment:
```
NEXT_PUBLIC_API_URL=https://my-stash-api.workers.dev
```

---

## 11. Topic Coverage Map: Capacity Analysis

| Metric | Value |
|---|---|
| Target categories | 8–10 |
| Subcategories per category | 4–8 |
| Topic slugs per subcategory (at maturity) | 10–30 |
| Max total slugs | ~2,000 |
| Avg slug length | ~30 chars |
| Total map size at 2,000 slugs | ~80 KB |

At 80 KB, the map would be a problem (too large for a prompt). Two safeguards:

1. **Slug compression:** Instead of storing full slugs, store only the first 20 chars of each slug. 2,000 × 20 = 40 KB.
2. **Hierarchical pruning:** After the map exceeds 1,000 slugs, a weekly "compression" cron runs that asks the AI to summarize sub-topics into category-level summary sentences rather than individual slug lists. Example:
   - Before: `["loss-aversion", "endowment-effect", "status-quo-bias", "anchoring", ...]` (30 items)
   - After: `"All major behavioral finance biases covered (30+ concepts)"` (50 chars)
   
   This summary is equally effective as a dedup signal to the AI.

**Practical capacity:** The system can run for **5–10 years** at 50 cards/day before the map needs pruning. Well beyond MVP.

---

## 12. Prompt Templates (Source of Truth)

All prompts live in `workers/src/generation/prompts.ts`:

```typescript
export const TITLE_GENERATION_PROMPT = (topicMap: string) => `
You are a microlearning content curator for "My Stash" — an app that helps people
collect bite-sized ideas across all areas of life.

Generate exactly 60 unique microlearning card titles for concepts a curious person
would genuinely want to learn about.

TOPIC DIVERSITY REQUIREMENT:
Include ideas from ALL of these domains (not only business):
- Mindset, psychology, cognitive biases
- Productivity and time management
- Personal finance and investing
- Technology, software, AI
- Creativity and design thinking
- Health, sleep, exercise, nutrition
- Leadership, negotiation, communication
- Science, philosophy, history
- Relationships and social dynamics

DEDUPLICATION REQUIREMENT:
The coverage map below shows what has ALREADY been generated. Do NOT repeat
or closely paraphrase anything listed there. Prefer under-populated subcategories
(those with fewer items). Empty subcategories are highest priority.

COVERAGE MAP:
${topicMap}

OUTPUT FORMAT — respond ONLY with this JSON, no other text:
{
  "titles": [
    {
      "title": "The Zeigarnik Effect",
      "category": "Mindset",
      "subcategory": "Memory & Cognition",
      "topic_slug": "zeigarnik-effect"
    }
  ]
}
`.trim();

export const NEAR_DEDUP_PROMPT = (existing: string[], candidates: object[]) => `
You are a deduplication filter. Identify which candidate titles are too semantically
similar to already-covered topics.

"Too similar" means: same underlying concept, even if the title is worded differently.
"Different enough" means: a meaningfully distinct angle, application, or concept.

ALREADY COVERED (topic slugs):
${JSON.stringify(existing)}

CANDIDATES:
${JSON.stringify(candidates)}

Respond ONLY with JSON — no other text:
{ "approved": [<subset of candidates that are genuinely different from existing>] }
`.trim();

export const CARD_EXPANSION_PROMPT = (titles: object[]) => `
You are a microlearning card writer. Write clear, insightful, actionable cards
that a curious person can absorb in 2–3 minutes.

WRITING RULES:
- Length: 80–150 words per card body (soft limit)
- Tone: educational but conversational — not corporate jargon
- Structure: start with a core insight, then explain with examples or sub-points
- Formatting: use **bold** for key terms, *italic* for emphasis, - lists for steps or examples
- Source: cite a real book, paper, person, or study. Never invent a source.
- Tags: pick 1–3 from: Mindset, Productivity, Finance, Tech, Creativity, Health, Leadership

OUTPUT FORMAT — respond ONLY with this JSON array, no other text:
[
  {
    "title": "...",
    "body": "...",
    "source": "...",
    "tags": ["..."]
  }
]

TITLES TO EXPAND:
${JSON.stringify(titles)}
`.trim();

export const MAP_UPDATE_PROMPT = (currentMap: string, newTopics: object[]) => `
Update the topic coverage map JSON by merging in the new topics.
- Add each new slug to the correct category/subcategory
- If the subcategory doesn't exist yet, create it
- Never remove existing entries
- Return ONLY the updated JSON object — no other text

CURRENT MAP:
${currentMap}

NEW TOPICS TO MERGE:
${JSON.stringify(newTopics)}
`.trim();
```

---

## 13. Error Handling & Resilience

| Failure scenario | Handling |
|---|---|
| OpenRouter rate limit / 429 | Exponential backoff (3 retries, 2s / 4s / 8s delays) |
| AI returns invalid JSON | Retry with stricter prompt once; log and skip if still invalid |
| D1 insert fails (quota/error) | Log error, continue inserting remaining cards |
| Cron fires but previous run in progress | `generation_log` check (Step 1) prevents double-runs |
| KV unreachable | Fall back to default topic map; log warning |
| All 60 title candidates are duplicates | Log `partial` status, schedule retry in 1 hour via `setTimeout` |
| `OPENROUTER_API_KEY` not set | Worker startup check logs error; returns 503 on all routes |

---

## 14. Build & Deployment Order

1. **Create Cloudflare resources:**
   ```bash
   wrangler d1 create my-stash-cards
   wrangler kv:namespace create MY_STASH_KV
   # Copy IDs into wrangler.toml
   ```

2. **Apply D1 schema:**
   ```bash
   wrangler d1 execute my-stash-cards --file=./schema.sql
   ```

3. **Set secrets:**
   ```bash
   wrangler secret put OPENROUTER_API_KEY
   wrangler secret put ADMIN_SECRET
   ```

4. **Seed the topic coverage map in KV:**
   ```bash
   wrangler kv:key put --namespace-id=<id> "topic-coverage-map" "$(cat seed-map.json)"
   ```

5. **Deploy the Worker:**
   ```bash
   wrangler deploy
   ```

6. **Trigger first batch manually:**
   ```bash
   curl -X POST https://my-stash-api.workers.dev/api/generate \
     -H "Authorization: Bearer $ADMIN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"requested": 50}'
   ```

7. **Update frontend environment variable:**
   - Cloudflare Pages → Settings → Environment variables → `NEXT_PUBLIC_API_URL = https://my-stash-api.workers.dev`
   - Redeploy Pages.

8. **Verify cron fires** next day at 05:00 UTC via Cloudflare Workers dashboard → Triggers tab.

---

## 15. Cost Estimate

| Item | Volume | Est. Cost/day |
|---|---|---|
| OpenRouter `gpt-luna-latest` — title gen (1 call, ~2K tokens) | 1×/day | ~$0.005 |
| OpenRouter — near-dedup filter (1 call, ~1K tokens) | 1×/day | ~$0.002 |
| OpenRouter — card expansion (5 calls × ~2K tokens) | 5×/day | ~$0.025 |
| OpenRouter — map update (1 call, ~3K tokens) | 1×/day | ~$0.008 |
| Cloudflare D1 (writes, reads) | ~500 ops/day | Free tier |
| Cloudflare KV (reads/writes) | ~20 ops/day | Free tier |
| Cloudflare Workers (cron + requests) | <1M req/month | Free tier |
| **Total** | | **~$0.04/day (~$1.20/month)** |

> Estimates based on OpenRouter pricing as of 2026-09. Adjust if model pricing changes.

---

## 16. Acceptance Criteria

- [ ] Cron fires daily at 05:00 UTC and inserts exactly 50 new cards into D1
- [ ] Re-running the cron on the same day is idempotent (no duplicates inserted)
- [ ] Topic coverage map updates after each batch and never references raw card body text
- [ ] After 30 days (1,500 cards), zero exact-duplicate titles exist in D1
- [ ] `GET /api/cards` returns paginated cards with <100ms response time (KV cache hit)
- [ ] Cards cover at least 6 distinct top-level categories per daily batch
- [ ] Frontend loads AI cards on first visit without blocking (graceful fallback if API unreachable)
- [ ] `POST /api/generate` requires valid `Authorization` header; returns 401 without it
- [ ] Worker deploys cleanly with `wrangler deploy` and passes `wrangler type-check`
- [ ] AI cards display with `✨ AI generated` badge; all user interactions (favorite, stash) work normally
