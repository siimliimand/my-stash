/**
 * Prompt templates — single source of truth, copied VERBATIM from plan §12.
 * Do not reword these; the plan is authoritative.
 */

export const TITLE_GENERATION_PROMPT = (topicMap: string): string => `
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

export const NEAR_DEDUP_PROMPT = (existing: string[], candidates: unknown[]): string => `
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

export const CARD_EXPANSION_PROMPT = (titles: unknown[]): string => `
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

export const MAP_UPDATE_PROMPT = (currentMap: string, newTopics: unknown[]): string => `
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

/** Appended once when an AI call returns unparseable JSON (plan §13:
 * "Retry with stricter prompt once"). */
export const JSON_RETRY_SUFFIX = 'Return ONLY the JSON object. No markdown fences, no commentary.';
