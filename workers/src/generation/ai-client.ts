/** OpenRouter chat-completions wrapper: retries with backoff, JSON-mode,
 * defensive JSON extraction, validator hook, and truncation self-correction
 * (finish_reason "length" => retry at a doubled cap). Web APIs only. */

import type { Env } from '../lib/types';
import { JSON_RETRY_SUFFIX } from './prompts';

const MAX_RETRIES = 3; // retries after the first attempt (plan §13: 2s / 4s / 8s)
const BASE_DELAYS_MS = [2000, 4000, 8000];
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * `max_completion_tokens` budget per pipeline call site, sized for a REASONING
 * model. The configured model spends hidden reasoning tokens before/while
 * writing its answer, and those tokens are capped AND billed as part of
 * `max_completion_tokens` — production observed `finish_reason: "length"` with
 * `usage: {completion_tokens: 4000, reasoning_tokens: 1404}`, leaving only
 * ~2,600 tokens of actual JSON and cutting the response mid-object. Each cap
 * is therefore: expected visible output + reasoning headroom (~1,400 tokens
 * typical, can spike), rounded up:
 *
 * | Call site            | Visible-output estimate                      | Cap    |
 * |----------------------|----------------------------------------------|--------|
 * | Title generation     | 24 title objects x ~70 tokens ≈ 1,700        | 10,000 |
 * |                      | (quota + 1 per category; ~4,500 at manual 50)|        |
 * | Near-dedup filter    | echoes ~24 short candidates + small verdict  |  4,000 |
 * | Card expansion       | 10 cards x 80–150 words ≈ 2,500–3,500 tokens |  8,000 |
 * | Map update           | echoes the full coverage map + merged output |  8,000 |
 */
export const TITLE_GENERATION_MAX_COMPLETION_TOKENS = 10_000;
export const NEAR_DEDUP_MAX_COMPLETION_TOKENS = 4_000;
export const CARD_EXPANSION_MAX_COMPLETION_TOKENS = 8_000;
export const MAP_UPDATE_MAX_COMPLETION_TOKENS = 8_000;

/** Hard ceiling for the truncation self-correction retry in `callAIJson`
 * (a doubled cap never exceeds this). */
export const MAX_COMPLETION_TOKENS_CEILING = 32_000;

export class AIError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    opts: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'AIError';
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export interface CallAIOptions {
  system?: string;
  user: string;
  temperature?: number;
  /** Sent as `max_completion_tokens` (`max_tokens` is deprecated upstream). */
  maxCompletionTokens?: number;
  /** Adds `response_format: { type: "json_object" }`. */
  jsonMode?: boolean;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: unknown };
}

/** The message content plus why the model stopped ("stop", "length", ...). */
interface CallAIResult {
  content: string;
  /** `finish_reason` from the first choice, or null when absent/unrecognized. */
  finishReason: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ±20% jitter so concurrent workers do not retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (1 + (Math.random() * 0.4 - 0.2)));
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null || header.trim().length === 0) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof TypeError) {
    // fetch() network failure — retryable
    return new AIError(`network error calling OpenRouter: ${err.message}`, { retryable: true });
  }
  return new AIError(err instanceof Error ? err.message : String(err), { retryable: false });
}

/**
 * One OpenRouter chat completion, returning the message content AND the
 * `finish_reason` ("length" means the response was cut off at
 * `max_completion_tokens`). Retries up to 3 times on 429/5xx/network
 * errors (2s/4s/8s backoff with ±20% jitter, honoring Retry-After when
 * present). No retry on 401 (invalid key) / 402 (credits).
 *
 * Handles OpenRouter's HTTP-200-with-error-body quirk: a provider failure can
 * arrive as `200 { "error": { code, message } }` — the body is always checked,
 * not just the status code.
 */
async function callAIWithMeta(env: Env, opts: CallAIOptions): Promise<CallAIResult> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new AIError('OPENROUTER_API_KEY is not set on the Worker', { status: 503, retryable: false });
  }

  const base = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const payload: Record<string, unknown> = {
    model: env.OPENROUTER_MODEL,
    messages: [
      ...(opts.system !== undefined ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.user },
    ],
  };
  if (typeof opts.temperature === 'number') payload.temperature = opts.temperature;
  if (typeof opts.maxCompletionTokens === 'number') payload.max_completion_tokens = opts.maxCompletionTokens;
  if (opts.jsonMode === true) payload.response_format = { type: 'json_object' };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'My Stash',
  };
  if (env.CORS_ORIGIN !== undefined && env.CORS_ORIGIN.length > 0) {
    headers['HTTP-Referer'] = env.CORS_ORIGIN;
  }

  let nextDelayOverride: number | null = null;
  let lastError = new AIError('OpenRouter call failed');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const baseDelay = BASE_DELAYS_MS[Math.min(attempt - 1, BASE_DELAYS_MS.length - 1)];
      await sleep(nextDelayOverride ?? jitter(baseDelay));
      nextDelayOverride = null;
    }

    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));

      let parsed: OpenRouterResponse;
      try {
        parsed = (await response.json()) as OpenRouterResponse;
      } catch {
        throw new AIError(`OpenRouter returned a non-JSON body (HTTP ${response.status})`, {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
          retryAfterMs,
        });
      }

      // CRITICAL: provider failures can surface as HTTP 200 + error object.
      const bodyError = parsed?.error;
      if (bodyError !== undefined && bodyError !== null) {
        const code = typeof bodyError.code === 'number' ? bodyError.code : Number(bodyError.code);
        const effectiveStatus = Number.isFinite(code) ? code : response.status;
        throw new AIError(
          `OpenRouter error${Number.isFinite(code) ? ` ${code}` : ''}: ${
            typeof bodyError.message === 'string' ? bodyError.message : 'unknown provider error'
          }`,
          { status: effectiveStatus, retryable: RETRYABLE_STATUS.has(effectiveStatus), retryAfterMs },
        );
      }

      if (!response.ok) {
        throw new AIError(`OpenRouter HTTP ${response.status}`, {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
          retryAfterMs,
        });
      }

      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        throw new AIError('OpenRouter response is missing choices[0].message.content', {
          status: response.status,
          retryable: true,
        });
      }
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
      return { content, finishReason };
    } catch (err) {
      lastError = toAIError(err);
      if (!lastError.retryable || attempt === MAX_RETRIES) break;
      if (lastError.retryAfterMs !== null) nextDelayOverride = lastError.retryAfterMs;
    }
  }

  throw lastError;
}

/** One OpenRouter chat completion; returns only the message content. */
export async function callAI(env: Env, opts: CallAIOptions): Promise<string> {
  return (await callAIWithMeta(env, opts)).content;
}

/**
 * Extract the first JSON value (object or array) from an AI response,
 * tolerating markdown fences and surrounding prose. Returns null when no
 * parseable JSON is present.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== 'string') return null;
  let candidate = text.trim();

  const fenced = candidate.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fenced !== null) candidate = fenced[1].trim();

  const firstObject = candidate.indexOf('{');
  const firstArray = candidate.indexOf('[');
  let start = -1;
  if (firstObject === -1) start = firstArray;
  else if (firstArray === -1) start = firstObject;
  else start = Math.min(firstObject, firstArray);
  if (start === -1) return null;

  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * callAI + JSON extraction + caller-provided validation, with a bounded
 * self-correction ladder on unusable output:
 *
 * 1. The call as specified.
 * 2. If it failed to parse/validate AND `finish_reason` was "length"
 *    (truncation — with a reasoning model the hidden reasoning tokens eat into
 *    `max_completion_tokens`, so the JSON can be cut mid-object): retry ONCE
 *    with the cap doubled (same messages, never above
 *    MAX_COMPLETION_TOKENS_CEILING).
 * 3. Still unparseable: the stricter-prompt retry (JSON_RETRY_SUFFIX), keeping
 *    the raised cap when truncation raised it, else the cap unchanged.
 *
 * Returns null when every attempt failed and no truncation was seen — the
 * caller decides what to do. Throws an AIError mentioning
 * `finish_reason=length` when truncation was seen and every attempt failed, so
 * the generation log stays diagnosable.
 */
export async function callAIJson<T>(
  env: Env,
  opts: CallAIOptions,
  validator: (value: unknown) => T | null,
): Promise<T | null> {
  const validate = (parsed: unknown): T | null => {
    try {
      return validator(parsed);
    } catch {
      return null;
    }
  };

  /** One OpenRouter attempt: the validated value (null = unusable) plus
   * the raw finish_reason so the ladder can detect truncation. */
  const attempt = async (
    maxCompletionTokens?: number,
    suffix?: string,
  ): Promise<{ value: T | null; finishReason: string | null }> => {
    const { content, finishReason } = await callAIWithMeta(env, {
      ...opts,
      user: suffix === undefined ? opts.user : `${opts.user}\n\n${suffix}`,
      ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
    });
    const parsed = extractJson(content);
    return { value: parsed === null ? null : validate(parsed), finishReason };
  };

  const first = await attempt();
  if (first.value !== null) return first.value;
  const truncated = first.finishReason === 'length';

  // Truncation self-correction: same messages, double the cap.
  const raisedCap =
    typeof opts.maxCompletionTokens === 'number'
      ? Math.min(opts.maxCompletionTokens * 2, MAX_COMPLETION_TOKENS_CEILING)
      : undefined;
  if (truncated && raisedCap !== undefined) {
    const raised = await attempt(raisedCap);
    if (raised.value !== null) return raised.value;
  }

  // Existing stricter-prompt retry — cap unchanged (unless truncation raised it).
  const stricter = await attempt(truncated ? raisedCap : opts.maxCompletionTokens, JSON_RETRY_SUFFIX);
  if (stricter.value !== null) return stricter.value;

  if (truncated) {
    const capDetail =
      raisedCap !== undefined
        ? ` (max_completion_tokens ${opts.maxCompletionTokens} -> ${raisedCap})`
        : '';
    throw new AIError(
      `AI response was truncated (finish_reason=length) and stayed unparseable after retrying at a doubled cap${capDetail} and with a stricter prompt`,
      { retryable: false },
    );
  }
  return null;
}
