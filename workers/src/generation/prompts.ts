/**
 * Prompt templates — single source of truth, copied VERBATIM from plan §12.
 * Do not reword these; the plan is authoritative. The one exception is
 * TITLE_GENERATION_PROMPT: the 2026-09-26 product spec change (2 cards per
 * category per day — README "Deviations" #20) added the per-category quota
 * section and replaced the fixed 60-title ask with a quota-derived total.
 */

import { CANONICAL_CATEGORIES } from './categories';

export const TITLE_GENERATION_PROMPT = (topicMap: string, quota: number): string => {
  const perCategory = quota + 1;
  const total = perCategory * CANONICAL_CATEGORIES.length;
  return `
You are a microlearning content curator for "My Stash" — an app that helps people
collect bite-sized ideas across all areas of life.

Generate exactly ${total} unique microlearning card titles for concepts a curious person
would genuinely want to learn about.

PER-CATEGORY QUOTA REQUIREMENT:
Propose exactly ${perCategory} titles for EACH of these ${CANONICAL_CATEGORIES.length}
categories — ${total} titles in total. Every title's category MUST be one of
these exact strings; anything else is discarded:
${CANONICAL_CATEGORIES.map((category) => `- ${category}`).join('\n')}

TOPIC DIVERSITY REQUIREMENT:
Include ideas from ALL of these canonical categories (these are the ONLY valid category strings — do not invent other categories):
- Mindset: cognitive biases, mental models, psychology, decision-making, behavioral economics
- Productivity: time management, focus, systems thinking, workflows, habit design
- Finance: investing, behavioral finance, personal finance, economics, market psychology
- Tech: software design, AI/ML, security, distributed systems, architecture principles
- Creativity: design thinking, idea generation, creative process, lateral thinking
- Health & Wellbeing: sleep science, exercise physiology, nutrition, stress management, longevity
- Leadership & Communication: negotiation, feedback, storytelling, influence, team dynamics
- Science: physics, neuroscience, biology, chemistry, history of science, mathematics

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
};

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
- Length: 80–150 words per card body (soft limit; keep under 180 words)
- Tone: educational, punchy, conversational — avoid corporate buzzwords and dry textbook definitions
- Structure:
  1. Start with a bold core thesis (**Core Insight in bold**)
  2. Ground it with a concrete hook: a specific study finding, a named person's real experience, or a vivid before/after scenario. Never write purely abstract definitions.
  3. Actionable takeaway ("So what?"): End with a practical takeaway or behavioral trigger ("When X happens, do Y").
- Formatting: use **bold** for key terms, *italic* for emphasis, and bulleted lists (-) for steps or examples
- Source: cite the most specific real book, paper, person, or study you are confident in (e.g. "Book Title — Author Name" or "Paper Title (Year) — Authors"). If not attributable to a specific work, cite the general field or originator truthfully (e.g. "Widely attributed in behavioral economics"). NEVER invent fake studies or citations.
- Tags: pick 1–3 from: Mindset, Productivity, Finance, Tech, Creativity, Health, Leadership, Science

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
