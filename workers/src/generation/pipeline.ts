/** The daily generation pipeline (plan §6, steps 1–10, with the PM-approved
 * adjustments: D1-first idempotency guard, recentTopicSlugs extension,
 * deterministic map-merge fallback, immediate-retry + partial status instead
 * of a 1-hour setTimeout, and a strongly-consistent D1 per-day run lock). */

import {
  AIError,
  callAIJson,
  CARD_EXPANSION_MAX_COMPLETION_TOKENS,
  MAP_UPDATE_MAX_COMPLETION_TOKENS,
  NEAR_DEDUP_MAX_COMPLETION_TOKENS,
  TITLE_GENERATION_MAX_COMPLETION_TOKENS,
} from './ai-client';
import {
  countWords,
  normalizeTitle,
  parseApprovedList,
  parseCardList,
  parseTitleList,
  sha256Prefix,
} from './dedup';
import { CANONICAL_CATEGORIES, DEFAULT_DAILY_REQUESTED, enforceCanonicalCategories } from './categories';
import {
  CARD_EXPANSION_PROMPT,
  MAP_UPDATE_PROMPT,
  NEAR_DEDUP_PROMPT,
  TITLE_GENERATION_PROMPT,
} from './prompts';
import {
  finalizeMergedMap,
  loadTopicMap,
  mergeTopicsDeterministic,
  RECENT_SLUGS_CAP,
  saveTopicMap,
} from './topic-map';
import {
  acquireRunLock,
  alreadyRanToday,
  chunkArray,
  finalizeRunLog,
  getExistingHashes,
  insertCards,
  releaseRunLock,
} from '../lib/db';
import { deleteKey, deletePrefix } from '../lib/kv';
import type {
  Env,
  ExpandedCard,
  GenerationStatus,
  NewTopic,
  PipelineResult,
  TitleCandidate,
  TopicCoverageMap,
} from '../lib/types';
import type { GeneratedCardRow } from '../lib/types';

const EXPANSION_BATCH_SIZE = 10;
/** Below this many usable title candidates the run is logged as 'failed'
 * (which allows a retry); with 10+ we proceed and likely land 'partial'. */
const MIN_CANDIDATES = 10;

const SYSTEM_TITLE = 'You are a microlearning content curator. Respond ONLY with valid JSON.';
const SYSTEM_NEAR_DEDUP = 'You are a deduplication filter. Respond ONLY with JSON.';
const SYSTEM_EXPANSION = 'You are a microlearning card writer. Respond ONLY with valid JSON.';
const SYSTEM_MAP_UPDATE = 'You update JSON data. Respond ONLY with the updated JSON object.';

/** KV keys holding cached API responses, invalidated after a batch (step 10). */
const TODAY_CACHE_KEY = 'api-cache:today';
const CARDS_CACHE_PREFIX = 'api-cache:cards:';

export interface RunGenerationOptions {
  /** Target number of cards for this run (1–50 manual override). Cron uses
   * the daily default: 2 cards per canonical category (16). */
  requested?: number;
}

function clampRequested(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DAILY_REQUESTED;
  return Math.min(50, Math.max(1, Math.floor(value)));
}

interface CandidateWithHash {
  candidate: TitleCandidate;
  hash: string;
}

/** Pair an expanded card back to the title candidate it came from: exact
 * normalized-title match first, positional fallback (the expansion prompt
 * lists titles in order), else undefined. */
function pairCandidate(card: ExpandedCard, batch: CandidateWithHash[], index: number): TitleCandidate | undefined {
  const key = normalizeTitle(card.title);
  const byTitle = batch.find((entry) => normalizeTitle(entry.candidate.title) === key);
  if (byTitle !== undefined) return byTitle.candidate;
  return batch[index]?.candidate;
}

/** Per-category selection (2026-09-26 spec change: exactly
 * CARDS_PER_CATEGORY_PER_DAY cards per category per day) — replaces the old
 * global slice(0, requested). Candidates are grouped per canonical category
 * in model order, then dealt round-robin (take-earliest within a category,
 * canonical order across them): a first pass takes up to `quota` titles per
 * category, and a second pass tops up from each category's remaining surplus
 * so a category that under-delivered lets the others fill the gap. Stops at
 * `requested` or when every list is exhausted. */
function selectAcrossCategories(entries: CandidateWithHash[], requested: number, quota: number): CandidateWithHash[] {
  const byCategory = new Map<string, CandidateWithHash[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.candidate.category);
    if (list === undefined) byCategory.set(entry.candidate.category, [entry]);
    else list.push(entry);
  }
  const categories = CANONICAL_CATEGORIES.filter((category) => byCategory.has(category));
  const selected: CandidateWithHash[] = [];
  // One round deals one title to each category that still has one.
  const dealRound = (round: number): boolean => {
    let progressed = false;
    for (const category of categories) {
      if (selected.length >= requested) break;
      const list = byCategory.get(category);
      if (list !== undefined && round < list.length) {
        selected.push(list[round]);
        progressed = true;
      }
    }
    return progressed;
  };
  for (let round = 0; round < quota && selected.length < requested; round++) dealRound(round);
  for (let round = quota; selected.length < requested; round++) {
    if (!dealRound(round)) break;
  }
  return selected;
}

export async function runGeneration(
  env: Env,
  ctx: ExecutionContext | null,
  opts: RunGenerationOptions = {},
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const requested = clampRequested(opts.requested);
  // Per-category selection quota (2026-09-26 spec): ceil(requested / 8), so 2
  // for the default 16. The title prompt asks for quota + 1 candidates per
  // category to keep a per-category surplus, like the old 60-for-50 ask.
  const quota = Math.ceil(requested / CANONICAL_CATEGORIES.length);
  const warnings: string[] = [];

  // ---- Step 0: strongly-consistent per-day run lock. A partial UNIQUE index
  // (generation_log(batch_date) WHERE status = 'running') lets at most one
  // cron/admin run in flight per day; KV is eventually consistent and must
  // not gate this. This must happen BEFORE the guard so two concurrent runs
  // cannot both slip past it.
  const lock = await acquireRunLock(env.DB, today, requested, env.OPENROUTER_MODEL);
  if (lock === 'held') {
    console.warn('[generate] another run holds the generation lock for today; skipping');
    return {
      status: 'skipped',
      skipped: true,
      reason: 'lock-held',
      batchDate: today,
      requested,
      generated: 0,
      skippedDuplicates: 0,
      durationMs: Date.now() - startedAt,
      warnings,
    };
  }
  // null = the lock row could not be written (D1 error); run best-effort.
  const lockId: string | null = lock?.id ?? null;
  if (lockId === null) warnings.push('could not write the running lock row; proceeding without it');

  const finishEarlyFailed = async (errorText: string): Promise<PipelineResult> => {
    const durationMs = Date.now() - startedAt;
    const logged = await finalizeRunLog(env.DB, lockId, {
      batchDate: today,
      requested,
      generated: 0,
      duplicatesSkip: 0,
      durationMs,
      model: env.OPENROUTER_MODEL,
      status: 'failed',
      error: errorText,
    });
    if (!logged) warnings.push('failed to write generation_log row for the failed run');
    return {
      status: 'failed',
      batchDate: today,
      requested,
      generated: 0,
      skippedDuplicates: 0,
      durationMs,
      warnings,
    };
  };

  // ---- Step 1: guard — already ran today? (D1 is the authoritative guard;
  // a day that produced zero cards — 'failed' or empty-'partial' — retries.)
  let alreadyDone = false;
  try {
    alreadyDone = await alreadyRanToday(env.DB, today);
  } catch (err) {
    warnings.push(`guard lookup failed (${err instanceof Error ? err.message : String(err)}); attempting run anyway`);
  }
  if (alreadyDone) {
    // Day is done: drop the lock row we just created so nothing is left
    // 'running' behind a skipped run.
    await releaseRunLock(env.DB, lockId);
    return {
      status: 'skipped',
      skipped: true,
      batchDate: today,
      requested,
      generated: 0,
      skippedDuplicates: 0,
      durationMs: Date.now() - startedAt,
      warnings,
    };
  }

  try {
    // ---- Step 2: load the topic coverage map (KV, with baked-in fallback)
    const { map: currentMap, usedFallback } = await loadTopicMap(env);
    if (usedFallback) warnings.push('topic-coverage-map missing or corrupt in KV; using the baked-in default map');

    // ---- Step 3: generate title candidates, quota + 1 per category (3 x 8 =
    // 24 for the default 16; callAIJson retries internally: a doubled cap when
    // the response was truncated, then a stricter prompt)
    const titleUser = TITLE_GENERATION_PROMPT(JSON.stringify(currentMap), quota);
    const titleOpts = {
      system: SYSTEM_TITLE,
      user: titleUser,
      temperature: 0.8,
      maxCompletionTokens: TITLE_GENERATION_MAX_COMPLETION_TOKENS,
      jsonMode: true,
    };

    let parsedTitles: TitleCandidate[] | null = null;
    try {
      parsedTitles = await callAIJson(env, titleOpts, parseTitleList);
      if (parsedTitles === null) {
        warnings.push('title generation returned unusable JSON even after the in-client retries');
      }
    } catch (err) {
      return finishEarlyFailed(
        `title generation AI call failed: ${err instanceof AIError ? err.message : String(err)}`,
      );
    }

    // ---- Step 3b: hard-enforce the canonical categories — the title AI
    // freewheels ("Technology", "History", ...): alias-normalize first, then
    // drop anything still non-canonical BEFORE dedup and the per-category
    // selection cut, so the per-category surplus absorbs the loss and no AI
    // calls are spent on candidates that can never be inserted.
    const { candidates, droppedCategories } = enforceCanonicalCategories(parsedTitles ?? []);
    if (droppedCategories.length > 0) {
      const names = [...new Set(droppedCategories)].sort().join(', ');
      warnings.push(`dropped ${droppedCategories.length} title(s) with non-canonical categories (${names})`);
    }
    if (candidates.length < MIN_CANDIDATES) {
      return finishEarlyFailed(
        `only ${candidates.length} valid title candidates after validation (minimum ${MIN_CANDIDATES})`,
      );
    }

    // ---- Step 4: hard dedup — title-hash check against D1
    let skippedDuplicates = 0;
    const candidateHashes = await Promise.all(candidates.map((c) => sha256Prefix(normalizeTitle(c.title))));
    let dbHashes = new Set<string>();
    try {
      dbHashes = await getExistingHashes(env.DB, candidateHashes);
    } catch (err) {
      warnings.push(`hard-dedup D1 lookup failed (${err instanceof Error ? err.message : String(err)}); proceeding without DB dedup`);
    }

    const seenHashes = new Set<string>();
    const unique: CandidateWithHash[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const hash = candidateHashes[i];
      if (dbHashes.has(hash) || seenHashes.has(hash)) {
        skippedDuplicates++;
        continue;
      }
      seenHashes.add(hash);
      unique.push({ candidate: candidates[i], hash });
    }

    // ---- Step 5: AI near-duplicate filter (availability over perfection)
    const recentSlugs = currentMap.recentTopicSlugs.slice(0, RECENT_SLUGS_CAP);
    let approved = unique;
    try {
      const approvedTitles = await callAIJson(
        env,
        {
          system: SYSTEM_NEAR_DEDUP,
          user: NEAR_DEDUP_PROMPT(recentSlugs, unique.map((entry) => entry.candidate)),
          temperature: 0.2,
          maxCompletionTokens: NEAR_DEDUP_MAX_COMPLETION_TOKENS,
          jsonMode: true,
        },
        parseApprovedList,
      );
      if (approvedTitles === null) {
        warnings.push('near-dedup filter returned unparseable JSON; proceeding without it');
      } else {
        // Enforce subset-ness: drop anything we did not send.
        const approvedKeys = new Set(approvedTitles.map((t) => normalizeTitle(t)));
        const filtered = unique.filter((entry) => approvedKeys.has(normalizeTitle(entry.candidate.title)));
        // An empty approval against a healthy candidate list is far more likely
        // a model failure than every candidate being a genuine duplicate —
        // keep everything instead.
        if (filtered.length === 0 && unique.length >= MIN_CANDIDATES) {
          warnings.push('near-dedup filter approved nothing; proceeding with the unfiltered list');
        } else {
          skippedDuplicates += unique.length - filtered.length;
          approved = filtered;
        }
      }
    } catch (err) {
      warnings.push(`near-dedup AI call failed (${err instanceof Error ? err.message : String(err)}); proceeding without it`);
    }

    // Per-category selection: up to `quota` per category first, then top-up
    // rounds from the remaining surplus (a category whose candidates were all
    // dropped or deduplicated is covered by the others).
    const targets = selectAcrossCategories(approved, requested, quota);

    // A category that contributed nothing (its candidates were all dropped or
    // deduplicated away) broke the even-spread guarantee — say so. Categories
    // with candidates left unselected are simply not needed to reach
    // `requested` (small manual runs) and are not a fault.
    const selectedCategories = new Set(targets.map((entry) => entry.candidate.category));
    const emptyCategories = CANONICAL_CATEGORIES.filter(
      (category) =>
        !selectedCategories.has(category) && !approved.some((entry) => entry.candidate.category === category),
    );
    if (emptyCategories.length > 0) {
      warnings.push(
        `no titles selected for ${emptyCategories.length} of the ${CANONICAL_CATEGORIES.length} categories (${emptyCategories.join(', ')})`,
      );
    }

    // ---- Step 6: expand approved titles into full cards, batches of 10
    // (2–3 batches for the default 16)
    let batchJsonFailures = 0;
    let invalidCards = 0;
    const expansionBatches = chunkArray(targets, EXPANSION_BATCH_SIZE);
    const batchResults = await Promise.all(
      expansionBatches.map(async (batch): Promise<{ tuples: Array<{ card: ExpandedCard; candidate: TitleCandidate }>; rejected: number }> => {
        const user = CARD_EXPANSION_PROMPT(batch.map((entry) => entry.candidate));
        const expansionOpts = {
          system: SYSTEM_EXPANSION,
          user,
          temperature: 0.7,
          maxCompletionTokens: CARD_EXPANSION_MAX_COMPLETION_TOKENS,
          jsonMode: true,
        };
        let cards: ExpandedCard[] | null = null;
        try {
          cards = await callAIJson(env, expansionOpts, parseCardList);
        } catch (err) {
          warnings.push(`expansion batch failed (${err instanceof Error ? err.message : String(err)}); its titles were skipped`);
          return { tuples: [], rejected: 0 };
        }
        if (cards === null) {
          batchJsonFailures++;
          warnings.push('expansion batch returned unusable JSON even after the in-client retries; its titles were skipped');
          return { tuples: [], rejected: 0 };
        }
        const tuples: Array<{ card: ExpandedCard; candidate: TitleCandidate }> = [];
        for (let i = 0; i < cards.length; i++) {
          const paired = pairCandidate(cards[i], batch, i);
          if (paired === undefined) continue;
          tuples.push({ card: cards[i], candidate: paired });
        }
        return { tuples, rejected: cards.length - tuples.length };
      }),
    );
    for (const result of batchResults) invalidCards += result.rejected;
    const expanded = batchResults.flatMap((result) => result.tuples);
    // Titles that produced no usable card at all (invalid output, unpaired
    // titles, or a whole batch that failed its JSON/error retries).
    const notExpanded = targets.length - expanded.length;

    // ---- Step 7: validate, hash, re-check, and insert
    const createdNow = new Date().toISOString();
    const prepared = expanded.map((tuple) => ({
      ...tuple,
      hash: '',
    }));
    await Promise.all(prepared.map((entry, i) => sha256Prefix(normalizeTitle(expanded[i].card.title)).then((h) => { entry.hash = h; })));

    // Expansion may have reworded a title: any hash we have not checked against
    // D1 yet gets one more lookup before insert.
    const unchecked = prepared.filter((entry) => !candidateHashes.includes(entry.hash) && !dbHashes.has(entry.hash));
    if (unchecked.length > 0) {
      try {
        const extra = await getExistingHashes(env.DB, unchecked.map((entry) => entry.hash));
        for (const hash of extra) dbHashes.add(hash);
      } catch (err) {
        warnings.push(`post-expansion dedup lookup failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    const withinBatchSeen = new Set<string>();
    const rows: GeneratedCardRow[] = [];
    let insertConflicts = 0;
    for (const entry of prepared) {
      const card = entry.card;
      if (dbHashes.has(entry.hash) || withinBatchSeen.has(entry.hash)) {
        insertConflicts++;
        continue;
      }
      withinBatchSeen.add(entry.hash);
      rows.push({
        id: crypto.randomUUID(),
        title: card.title,
        body: card.body,
        source: card.source,
        tags: JSON.stringify(card.tags),
        category: entry.candidate.category,
        subcategory: entry.candidate.subcategory,
        topic_slug: entry.candidate.topic_slug,
        title_hash: entry.hash,
        batch_date: today,
        created_at: createdNow,
        word_count: countWords(card.body),
      });
    }

    const changes = await insertCards(env.DB, rows);
    const insertedRows: GeneratedCardRow[] = [];
    let insertFailures = 0;
    for (let i = 0; i < rows.length; i++) {
      if ((changes[i] ?? 0) > 0) insertedRows.push(rows[i]);
      else insertFailures++;
    }
    skippedDuplicates += insertConflicts;

    const generated = insertedRows.length;

    // ---- Step 8: update the topic coverage map (cards are already committed —
    // a map failure must never fail the batch)
    if (insertedRows.length > 0) {
      const newTopics: NewTopic[] = insertedRows.map((row) => ({
        category: row.category,
        subcategory: row.subcategory,
        slug: row.topic_slug,
      }));

      let nextMap: TopicCoverageMap | null = null;
      try {
        const aiMerged = await callAIJson<unknown>(
          env,
          {
            system: SYSTEM_MAP_UPDATE,
            user: MAP_UPDATE_PROMPT(JSON.stringify(currentMap), newTopics),
            temperature: 0.2,
            maxCompletionTokens: MAP_UPDATE_MAX_COMPLETION_TOKENS,
            jsonMode: true,
          },
          (value) => value,
        );
        if (aiMerged !== null) nextMap = finalizeMergedMap(aiMerged, currentMap, newTopics);
      } catch {
        // fall through to the deterministic merge
      }
      if (nextMap === null) {
        warnings.push('AI map merge failed or produced an invalid map; used the deterministic local merge');
        nextMap = mergeTopicsDeterministic(currentMap, newTopics);
      }

      const saved = await saveTopicMap(env, nextMap);
      if (!saved) warnings.push('failed to write the updated topic map to KV');
    }

    // ---- Step 9: log the batch ('success' when >= 80% of the target landed)
    const durationMs = Date.now() - startedAt;
    const status: GenerationStatus = generated >= requested * 0.8 ? 'success' : 'partial';
    const problemParts: string[] = [];
    if (notExpanded > 0) problemParts.push(`${notExpanded} of ${targets.length} titles produced no valid card`);
    if (batchJsonFailures > 0) problemParts.push(`${batchJsonFailures} expansion batches returned bad JSON`);
    if (insertConflicts > 0) problemParts.push(`${insertConflicts} duplicates caught at insert time`);
    if (insertFailures > 0) problemParts.push(`${insertFailures} D1 insert failures`);
    const errorText = status === 'success' ? null : problemParts.join('; ') || 'generated fewer cards than requested';

    const logged = await finalizeRunLog(env.DB, lockId, {
      batchDate: today,
      requested,
      generated,
      duplicatesSkip: skippedDuplicates,
      durationMs,
      model: env.OPENROUTER_MODEL,
      status,
      error: errorText,
    });
    if (!logged) warnings.push('failed to write the generation_log row');

    // ---- Step 10: invalidate the API response cache
    const invalidate = async (): Promise<void> => {
      await deleteKey(env.KV, TODAY_CACHE_KEY);
      await deletePrefix(env.KV, CARDS_CACHE_PREFIX);
    };
    if (ctx !== null) ctx.waitUntil(invalidate());
    else await invalidate();

    // ---- Step 11: report
    return {
      status,
      batchDate: today,
      requested,
      generated,
      skippedDuplicates,
      durationMs,
      warnings,
    };
  } catch (err) {
    // Unexpected crash: the lock row must end 'failed' (retryable) — never
    // stranded as 'running' (the 30-minute stale-lock sweep only covers a
    // dead isolate).
    const durationMs = Date.now() - startedAt;
    const logged = await finalizeRunLog(env.DB, lockId, {
      batchDate: today,
      requested,
      generated: 0,
      duplicatesSkip: 0,
      durationMs,
      model: env.OPENROUTER_MODEL,
      status: 'failed',
      error: `pipeline crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
    if (!logged) warnings.push('failed to write the generation_log row for the crashed run');
    throw err;
  }
}
