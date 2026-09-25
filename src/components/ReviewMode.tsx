"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Heart, Clock, Tag, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/context/AppContext";
import { Card } from "@/lib/types";
import { MarkdownLite, estimateReadTime } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const REVIEW_BATCH_SIZE = 7;

interface ReviewModeProps {
  onClose: () => void;
}

function pickReviewCards(cards: Card[]): Card[] {
  if (cards.length === 0) return [];

  // Score each card: lower lastReviewedAt = higher priority; favorites get a boost
  const now = Date.now();
  const scored = cards.map((c) => {
    const daysSince = c.lastReviewedAt
      ? (now - new Date(c.lastReviewedAt).getTime()) / 86400000
      : 999; // never reviewed = highest priority
    const favBonus = c.favorite ? 5 : 0;
    return { card: c, score: daysSince + favBonus };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, REVIEW_BATCH_SIZE).map((s) => s.card);
}

export function ReviewMode({ onClose }: ReviewModeProps) {
  const { data, dispatch } = useApp();
  const [reviewCards] = useState<Card[]>(() => pickReviewCards(data.cards));
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const prefersReduced = typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  const card = reviewCards[index];
  const total = reviewCards.length;

  useEffect(() => {
    if (!card) return;
    // Mark reviewed on first reveal
    if (revealed) {
      dispatch({ type: "MARK_REVIEWED", cardId: card.id });
    }
  }, [revealed, card, dispatch]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && revealed) goNext();
      if (e.key === " " && !revealed) setRevealed(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function goNext() {
    if (index < total - 1) {
      setDirection(1);
      setIndex(index + 1);
      setRevealed(false);
    } else {
      setDone(true);
    }
  }

  function goPrev() {
    if (index > 0) {
      setDirection(-1);
      setIndex(index - 1);
      setRevealed(true);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Daily review mode"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>✨</span>
          <div>
            <h2 className="font-semibold text-sm">Daily Review</h2>
            <p className="text-xs text-muted-foreground">
              {done ? "Session complete!" : `${index + 1} of ${total} cards`}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close review">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted" role="progressbar" aria-valuenow={done ? total : index} aria-valuemin={0} aria-valuemax={total}>
        <motion.div
          className="h-full bg-primary"
          initial={false}
          animate={{ width: `${(done ? total : index + (revealed ? 1 : 0)) / total * 100}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-4 py-8">
        {done ? (
          <DoneScreen count={total} onClose={onClose} />
        ) : !card ? (
          <div className="text-center space-y-3">
            <div className="text-4xl" aria-hidden>🎉</div>
            <p className="font-medium">No cards to review!</p>
            <p className="text-sm text-muted-foreground">Add some cards first.</p>
            <Button onClick={onClose}>Go back</Button>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={card.id}
              initial={prefersReduced ? {} : { opacity: 0, x: direction * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={prefersReduced ? {} : { opacity: 0, x: direction * -40 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-lg space-y-4"
            >
              {/* Tags & meta */}
              <div className="flex flex-wrap items-center gap-2">
                {card.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    <Tag className="h-2.5 w-2.5 mr-1" />
                    {tag}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
                  <Clock className="h-3 w-3" />
                  {estimateReadTime(card.body)} min
                </span>
              </div>

              {/* Title */}
              <h3 className="text-xl font-semibold leading-snug">{card.title}</h3>

              {/* Reveal toggle */}
              <AnimatePresence>
                {!revealed ? (
                  <motion.div
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-3"
                  >
                    <div className="h-24 rounded-xl bg-muted flex items-center justify-center cursor-pointer border-2 border-dashed border-border hover:border-primary transition-colors"
                      onClick={() => setRevealed(true)}
                      role="button"
                      tabIndex={0}
                      aria-label="Reveal card content (press Space)"
                      onKeyDown={(e) => e.key === " " && setRevealed(true)}
                    >
                      <p className="text-sm text-muted-foreground">Tap to reveal · Space</p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <MarkdownLite content={card.body} className="text-sm leading-relaxed" />
                    {card.source && (
                      <p className="mt-3 text-xs text-muted-foreground flex items-center gap-1.5">
                        <BookOpen className="h-3 w-3 shrink-0" />
                        {card.source}
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Review footer */}
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goPrev}
                  disabled={index === 0}
                  aria-label="Previous review card"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Prev
                </Button>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => dispatch({ type: "TOGGLE_FAVORITE", cardId: card.id })}
                    aria-label={card.favorite ? "Remove from favorites" : "Add to favorites"}
                    aria-pressed={card.favorite}
                  >
                    <Heart className={cn("h-4 w-4", card.favorite ? "fill-red-500 text-red-500" : "")} />
                  </Button>
                </div>

                <Button
                  variant={revealed ? "default" : "outline"}
                  size="sm"
                  onClick={revealed ? goNext : () => setRevealed(true)}
                  aria-label={revealed ? (index < total - 1 ? "Next review card" : "Finish review") : "Reveal card"}
                >
                  {!revealed ? "Reveal" : index < total - 1 ? (
                    <>Next <ChevronRight className="h-4 w-4 ml-1" /></>
                  ) : "Finish"}
                </Button>
              </div>

              {/* Review count hint */}
              <p className="text-xs text-center text-muted-foreground/60">
                Reviewed {card.reviewCount} time{card.reviewCount !== 1 ? "s" : ""} before
              </p>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function DoneScreen({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <div className="text-center space-y-4 max-w-xs">
      <div className="text-5xl" aria-hidden>🎉</div>
      <h3 className="text-xl font-semibold">Session complete!</h3>
      <p className="text-sm text-muted-foreground">
        You reviewed {count} card{count !== 1 ? "s" : ""}. Great work keeping your knowledge fresh.
      </p>
      <Button onClick={onClose}>Back to stash</Button>
    </div>
  );
}
