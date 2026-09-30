import { Card, Stash, AppData } from "./types";
import { SCHEMA_VERSION } from "./storage";

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function uuid(): string {
  return crypto.randomUUID();
}

const SEED_CARDS: Omit<Card, "id" | "createdAt" | "updatedAt" | "origin">[] = [
  {
    title: "Parkinson's Law",
    body: "**Work expands to fill the time available for its completion.** If you give yourself a week to complete a two-hour task, the task will grow in complexity to fill that week.\n\nThe fix is simple: set *shorter, tighter deadlines*. Artificial constraints force focus and cut unnecessary complexity.\n\n- Estimate tasks honestly, then halve your estimate\n- Time-box work sessions to create urgency\n- Deadlines are a feature, not a bug",
    source: "Cyril Northcote Parkinson, The Economist (1955)",
    tags: ["Productivity"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "The Power of Compounding",
    body: "**Small consistent improvements compound into extraordinary results over time.** Warren Buffett made 97% of his net worth after turning 65 — not because he suddenly got smarter, but because compounding had more time to work.\n\nThe same applies to knowledge, habits, and skills. A 1% daily improvement yields a 37× improvement over a year.\n\n- Start small, but *start now*\n- Consistency beats intensity\n- Reinvest gains instead of spending them",
    source: "The Snowball: Warren Buffett and the Business of Life",
    tags: ["Finance", "Mindset"],
    favorite: true,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "The Inversion Principle",
    body: "**Instead of asking how to succeed, ask how to avoid failure.** Charlie Munger calls this \"thinking forward and backward\" — invert the problem to find blind spots that forward-thinking misses.\n\n*Example:* Instead of \"How do I build a great product?\" ask \"What would make users hate this product?\" Then avoid those things.\n\n- Inversion finds risks that optimism overlooks\n- Pre-mortem thinking: imagine failure and work backward\n- Eliminate the obvious failure modes first",
    source: "Poor Charlie's Almanack — Charlie Munger",
    tags: ["Mindset", "Productivity"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "The Eisenhower Matrix",
    body: "**Prioritize tasks by urgency and importance**, not just urgency alone. President Eisenhower distinguished between the two:\n\n- **Urgent + Important** — do now\n- **Important, not urgent** — schedule it (this is where leverage lives)\n- **Urgent, not important** — delegate or decline\n- **Neither** — eliminate\n\nMost people live in the \"urgent but not important\" quadrant — meetings, interruptions, emails. The real leverage is in \"important but not urgent\": strategy, relationships, learning.\n\n- Ask: *is this actually important, or just feels urgent?*\n- Guard time for Quadrant II ruthlessly",
    source: "First Things First — Stephen R. Covey",
    tags: ["Productivity"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "Loss Aversion",
    body: "**Losses hurt roughly twice as much as equivalent gains feel good.** Losing $100 is psychologically more painful than gaining $100 is pleasurable.\n\nThis bias drives poor financial decisions:\n- Holding losing stocks too long (refusing to \"lock in\" a loss)\n- Selling winning stocks too early\n- Avoiding good risks because the downside feels outsized\n\n*The antidote:* evaluate decisions by expected value, not by how the outcome would *feel*. Separate the math from the emotion.",
    source: "Thinking, Fast and Slow — Daniel Kahneman",
    tags: ["Finance", "Mindset"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "Second-Order Thinking",
    body: "**First-order thinking asks \"what will happen?\" Second-order thinking asks \"and then what?\"**\n\nMost people stop at the immediate consequence. Second-order thinkers consider knock-on effects, unintended consequences, and how systems adapt.\n\n*Example:* Antibiotics cure infection (1st order) → but overuse breeds resistant bacteria (2nd order) → future infections become untreatable (3rd order).\n\n- Ask \"and then what?\" at least twice after any decision\n- Consider how others will react and adapt\n- Short-term obvious moves often have long-term hidden costs",
    source: "The Most Important Thing — Howard Marks",
    tags: ["Mindset", "Tech"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "The 2-Minute Rule",
    body: "**If a task takes less than two minutes, do it immediately** instead of scheduling, deferring, or adding it to a list.\n\nThe overhead of managing small tasks in a system costs more than just doing them. A quick reply, a file rename, a dish — deferral adds cognitive load without saving time.\n\nFor larger habits, the rule has a second form: *make the start of the habit take less than two minutes.* You don't commit to a 30-minute run — you commit to putting on your shoes.\n\n- Low-friction starts remove procrastination\n- Two minutes eliminates the \"I'll do it later\" spiral",
    source: "Getting Things Done — David Allen",
    tags: ["Productivity"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
  {
    title: "Occam's Razor",
    body: "**Among competing explanations, prefer the simplest one that fits the evidence.** Entities should not be multiplied beyond necessity.\n\nIn practice: when debugging a system, suspect the most mundane cause first. When designing, resist adding complexity until you've exhausted simple solutions.\n\n- Complexity is often a defense mechanism against thinking clearly\n- \"It works\" is sufficient; \"it's elegant\" is a bonus\n- *Simple is not the same as easy* — simplicity takes deliberate effort\n\nUsed well, Occam's Razor saves time, reduces maintenance burden, and keeps systems understandable.",
    source: "William of Ockham (14th century) / popularized in modern philosophy of science",
    tags: ["Mindset", "Tech"],
    favorite: false,
    lastReviewedAt: null,
    reviewCount: 0,
  },
];

export function createSeedData(): AppData {
  const now = new Date();
  const cards: Card[] = SEED_CARDS.map((seed, i) => {
    const createdAt = new Date(now.getTime() - (SEED_CARDS.length - i) * 86400000);
    return {
      ...seed,
      id: uuid(),
      createdAt: iso(createdAt),
      updatedAt: iso(createdAt),
      origin: "user",
    };
  });

  const defaultStash: Stash = {
    id: uuid(),
    name: "Weekend Reading",
    cardIds: [cards[0].id, cards[5].id, cards[7].id],
    createdAt: iso(now),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    cards,
    stashes: [defaultStash],
    settings: { theme: "system" },
  };
}
