"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import {
  Heart, MoreHorizontal, ChevronLeft, ChevronRight,
  Clock, Tag, BookOpen, Copy, Pencil, Trash2, ArrowUpDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/context/AppContext";
import { Card, SortMode } from "@/lib/types";
import { MarkdownLite, estimateReadTime } from "@/lib/markdown";
import { CardModal } from "./CardModal";
import { StashPopover } from "./StashPopover";
import { cn } from "@/lib/utils";

const SWIPE_THRESHOLD = 80;

export function CardDeck() {
  const { filteredCards, currentIndex, sortMode, dispatch, searchQuery, filter } = useApp();
  const [editCard, setEditCard] = useState<Card | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Card | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);

  const cards = filteredCards;
  const total = cards.length;
  const card = cards[currentIndex] ?? null;

  // Keyboard navigation
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") goNext();
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") goPrev();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function goNext() {
    if (currentIndex < total - 1) {
      setDirection(1);
      dispatch({ type: "SET_INDEX", index: currentIndex + 1 });
    }
  }

  function goPrev() {
    if (currentIndex > 0) {
      setDirection(-1);
      dispatch({ type: "SET_INDEX", index: currentIndex - 1 });
    }
  }

  function handleToggleFavorite(cardId: string) {
    dispatch({ type: "TOGGLE_FAVORITE", cardId });
  }

  function handleDelete(c: Card) {
    setDeleteConfirm(c);
  }

  function confirmDelete() {
    if (deleteConfirm) {
      dispatch({ type: "DELETE_CARD", cardId: deleteConfirm.id });
      setDeleteConfirm(null);
    }
  }

  function handleCopy(c: Card) {
    const text = `${c.title}\n\n${c.body}\n\n— ${c.source}`;
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function setSortMode(sort: SortMode) {
    dispatch({ type: "SET_SORT", sort });
  }

  function clearFilters() {
    dispatch({ type: "SET_FILTER", filter: { type: "all" } });
    dispatch({ type: "SET_SEARCH", query: "" });
    dispatch({ type: "SET_SORT", sort: "newest" });
  }

  const hasActiveFilters = filter.type !== "all" || searchQuery.trim() || sortMode !== "newest";

  if (total === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16 text-center gap-4">
        <div className="text-5xl" aria-hidden>📭</div>
        <h2 className="text-lg font-semibold">No cards found</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          {searchQuery
            ? `No cards match "${searchQuery}".`
            : "This filter returned no results."}
        </p>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center px-4 pb-8">
      {/* Sort controls */}
      <div className="w-full max-w-lg flex items-center justify-between py-3">
        <span className="text-sm text-muted-foreground">
          {currentIndex + 1} <span className="text-muted-foreground/50">of</span> {total}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-transparent px-2.5 text-xs font-medium text-muted-foreground transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowUpDown className="h-3 w-3" />
            {sortMode === "newest" ? "Newest" : sortMode === "favorites" ? "Favorites" : "Most reviewed"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSortMode("newest")}>
              Newest first
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortMode("favorites")}>
              Favorites only
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSortMode("most-reviewed")}>
              Most revisited
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Card */}
      {card && (
        <SwipeableCard
          card={card}
          key={card.id}
          direction={direction}
          onNext={goNext}
          onPrev={goPrev}
          onFavorite={() => handleToggleFavorite(card.id)}
          onEdit={() => setEditCard(card)}
          onDelete={() => handleDelete(card)}
          onCopy={() => handleCopy(card)}
          canGoNext={currentIndex < total - 1}
          canGoPrev={currentIndex > 0}
          setDirection={setDirection}
          dispatch={dispatch}
        />
      )}

      {/* Edit modal */}
      {editCard && (
        <CardModal
          mode="edit"
          card={editCard}
          onClose={() => setEditCard(null)}
        />
      )}

      {/* Delete confirm dialog */}
      {deleteConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
        >
          <div className="bg-background rounded-xl border border-border shadow-lg p-6 max-w-sm w-full space-y-4">
            <h3 id="delete-title" className="font-semibold">Delete card?</h3>
            <p className="text-sm text-muted-foreground">
              "{deleteConfirm.title}" will be permanently removed from all stashes.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
              <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SwipeableCardProps {
  card: Card;
  direction: 1 | -1;
  canGoNext: boolean;
  canGoPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  onFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  setDirection: (d: 1 | -1) => void;
  dispatch: ReturnType<typeof useApp>["dispatch"];
}

function SwipeableCard({
  card, direction, canGoNext, canGoPrev,
  onNext, onPrev, onFavorite, onEdit, onDelete, onCopy, setDirection,
}: SwipeableCardProps) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-8, 8]);
  const opacity = useTransform(x, [-150, 0, 150], [0.5, 1, 0.5]);
  const dragRef = useRef(false);
  const prefersReduced = useRef(false);

  useEffect(() => {
    prefersReduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  function handleDragEnd(_: unknown, info: { offset: { x: number } }) {
    dragRef.current = false;
    if (info.offset.x < -SWIPE_THRESHOLD && canGoNext) {
      setDirection(1);
      onNext();
    } else if (info.offset.x > SWIPE_THRESHOLD && canGoPrev) {
      setDirection(-1);
      onPrev();
    }
  }

  const readTime = estimateReadTime(card.body);

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={card.id}
        custom={direction}
        initial={prefersReduced.current ? {} : { opacity: 0, x: direction * 60 }}
        animate={{ opacity: 1, x: 0 }}
        exit={prefersReduced.current ? {} : { opacity: 0, x: direction * -60 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        style={{ x, rotate, opacity }}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.15}
        onDragStart={() => { dragRef.current = true; }}
        onDragEnd={handleDragEnd}
        className="w-full max-w-lg bg-card border border-border rounded-2xl shadow-sm overflow-hidden cursor-grab active:cursor-grabbing select-none"
        aria-label={`Card: ${card.title}`}
      >
        {/* Card header */}
        <div className="px-5 pt-5 pb-3 border-b border-border/50 flex flex-wrap items-start gap-2">
          <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
            {card.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                <Tag className="h-2.5 w-2.5 mr-1" />
                {tag}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {readTime} min
            </span>
          </div>
        </div>

        {/* Card body */}
        <div className="px-5 py-4">
          <h2 className="text-lg font-semibold leading-snug mb-3">{card.title}</h2>
          <MarkdownLite content={card.body} className="text-sm text-card-foreground/90" />
        </div>

        {/* Card source */}
        {card.source && (
          <div className="px-5 pb-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <BookOpen className="h-3 w-3 shrink-0" />
              {card.source}
            </p>
          </div>
        )}

        {/* Card footer */}
        <div className="px-5 py-3 border-t border-border/50 flex items-center gap-2">
          {/* Favorite */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onFavorite}
            aria-label={card.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={card.favorite}
          >
            <Heart
              className={cn("h-4 w-4 transition-colors", card.favorite ? "fill-red-500 text-red-500" : "")}
            />
          </Button>

          {/* Stash to */}
          <StashPopover cardId={card.id} />

          {/* Overflow menu */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-sm font-medium transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-2" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopy}>
                <Copy className="h-4 w-4 mr-2" /> Copy as text
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Prev / Next */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onPrev}
              disabled={!canGoPrev}
              aria-label="Previous card"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onNext}
              disabled={!canGoNext}
              aria-label="Next card"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
