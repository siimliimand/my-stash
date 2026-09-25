/**
 * Unit tests for callAIJson's truncation self-correction (ai-client.ts).
 *
 * The configured model is a REASONING model: its hidden reasoning tokens count
 * against max_completion_tokens, so a response can come back with
 * finish_reason "length" and the JSON cut mid-object. global fetch is stubbed
 * with a scripted OpenRouter server, the same way
 * pipeline.integration.test.ts does it.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { callAIJson, MAX_COMPLETION_TOKENS_CEILING } from '../src/generation/ai-client';
import { parseTitleList } from '../src/generation/dedup';
import { JSON_RETRY_SUFFIX } from '../src/generation/prompts';
import type { Env } from '../src/lib/types';

interface RecordedRequest {
  url: string;
  body: { max_completion_tokens?: number; messages?: Array<{ role: string; content: string }> };
}

function makeEnv(): Env {
  return {
    OPENROUTER_MODEL: 'test-model',
    OPENROUTER_BASE_URL: 'https://ai.test/v1',
    CORS_ORIGIN: 'https://frontend.test',
    OPENROUTER_API_KEY: 'test-key',
  } as unknown as Env;
}

function aiResponse(content: string, finishReason?: string): Response {
  const choice: { message: { content: string }; finish_reason?: string } = { message: { content } };
  if (finishReason !== undefined) choice.finish_reason = finishReason;
  return new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
}

/** Stub global fetch with a scripted sequence of responses (the last one
 * repeats) and record every request body for assertions. */
function stubFetchSequence(responses: Array<{ content: string; finishReason?: string }>): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: String(input),
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
      });
      const scripted = responses[Math.min(call, responses.length - 1)];
      call++;
      return aiResponse(scripted.content, scripted.finishReason);
    }),
  );
  return requests;
}

// Cut mid-string: unparseable JSON, exactly what finish_reason=length produces.
const CUT_JSON = '{"titles": [{"title": "Truncated Ti';
const GOOD_JSON = JSON.stringify({
  titles: [{ title: 'Whole Idea', category: 'Mindset', subcategory: 'Memory', topic_slug: 'whole-idea' }],
});

describe('callAIJson truncation self-correction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const opts = { user: 'generate titles', maxCompletionTokens: 5000, jsonMode: true };

  test('truncated first response -> retries once at double the cap and succeeds', async () => {
    const requests = stubFetchSequence([
      { content: CUT_JSON, finishReason: 'length' },
      { content: GOOD_JSON, finishReason: 'stop' },
    ]);

    const titles = await callAIJson(makeEnv(), opts, parseTitleList);

    expect(titles).toHaveLength(1);
    expect(titles?.[0]?.title).toBe('Whole Idea');
    expect(requests).toHaveLength(2);
    // Second request's cap is 2x the first: reasoning tokens count against
    // max_completion_tokens, so the doubled cap must cover reasoning + output.
    expect(requests[0]!.body.max_completion_tokens).toBe(5000);
    expect(requests[1]!.body.max_completion_tokens).toBe(10_000);
    // Same messages on the truncation retry — no stricter suffix yet.
    expect(requests[1]!.body.messages?.at(-1)?.content).toBe('generate titles');
  });

  test('always truncated -> clean failure with finish_reason=length in the error', async () => {
    const requests = stubFetchSequence([{ content: CUT_JSON, finishReason: 'length' }]);

    await expect(callAIJson(makeEnv(), opts, parseTitleList)).rejects.toThrow(/finish_reason=length/);

    // Order: original cap -> doubled cap -> stricter-prompt retry at the raised cap.
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.body.max_completion_tokens)).toEqual([5000, 10_000, 10_000]);
    expect(requests[2]!.body.messages?.at(-1)?.content).toBe(`generate titles\n\n${JSON_RETRY_SUFFIX}`);
  });

  test('non-truncation parse failure -> stricter-prompt retry at the unchanged cap', async () => {
    const requests = stubFetchSequence([
      { content: CUT_JSON }, // unparseable, but finish_reason is absent (not "length")
      { content: GOOD_JSON },
    ]);

    const titles = await callAIJson(makeEnv(), opts, parseTitleList);

    expect(titles).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.max_completion_tokens).toBe(5000);
    expect(requests[1]!.body.max_completion_tokens).toBe(5000); // cap unchanged
    expect(requests[1]!.body.messages?.at(-1)?.content).toBe(`generate titles\n\n${JSON_RETRY_SUFFIX}`);
  });

  test('a doubled cap never exceeds the 32,000 ceiling', async () => {
    const requests = stubFetchSequence([
      { content: CUT_JSON, finishReason: 'length' },
      { content: GOOD_JSON, finishReason: 'stop' },
    ]);

    const titles = await callAIJson(makeEnv(), { ...opts, maxCompletionTokens: 20_000 }, parseTitleList);

    expect(titles).toHaveLength(1);
    expect(requests[1]!.body.max_completion_tokens).toBe(MAX_COMPLETION_TOKENS_CEILING);
  });
});
