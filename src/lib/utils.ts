export { cn } from "cn"

import type { Card } from "./types";

/** The batch date of the most recent AI delivery present in `cards`
 * (batchDate values are UTC dates, so lexical compare works). */
export function latestAiBatchDate(cards: Card[]): string | undefined {
  let latest: string | undefined;
  for (const c of cards) {
    if (c.origin !== "ai" || !c.batchDate) continue;
    if (!latest || c.batchDate > latest) latest = c.batchDate;
  }
  return latest;
}

/** Cards belonging to the most recent AI batch — what the "AI Daily"
 * filter shows. Older batches stay available under "All". */
export function isLatestAiBatch(card: Card, batchDate: string | undefined): boolean {
  return card.origin === "ai" && card.batchDate !== undefined && card.batchDate === batchDate;
}
