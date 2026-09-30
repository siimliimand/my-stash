"use client";

import { useRef, useState } from "react";
import { useApp } from "@/context/AppContext";
import { FilterMode } from "@/lib/types";
import { cn, latestAiBatchDate, isLatestAiBatch } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { MoreHorizontal } from "lucide-react";

const DEFAULT_TAGS = ["Mindset", "Productivity", "Tech", "Finance", "Creativity"];

export function FilterBar() {
  const { allCards, data, filter, dispatch } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Collect all tags from cards (includes custom ones beyond defaults)
  const allTags = Array.from(
    new Set([...DEFAULT_TAGS, ...allCards.flatMap((c) => c.tags)])
  ).sort();

  // AI Daily counts only the most recent batch — the accumulated archive
  // stays reachable via All / tags / search.
  const aiBatchDate = latestAiBatchDate(allCards);
  const aiCount = aiBatchDate
    ? allCards.filter((c) => isLatestAiBatch(c, aiBatchDate)).length
    : 0;

  // Stash pills count only cards we can actually display: a stash may still
  // reference ids that are not in allCards (e.g. the API was unreachable and
  // AI cards are missing this session).
  const knownCardIds = new Set(allCards.map((c) => c.id));

  function setFilter(f: FilterMode) {
    dispatch({ type: "SET_FILTER", filter: f });
  }

  function isActive(f: FilterMode): boolean {
    if (f.type !== filter.type) return false;
    if (f.type === "all" || f.type === "ai-today") return true;
    if (f.type === "tag" && filter.type === "tag") return f.tag === filter.tag;
    if (f.type === "stash" && filter.type === "stash") return f.stashId === filter.stashId;
    return false;
  }

  function handleRenameStash(id: string, currentName: string) {
    const name = window.prompt("Rename stash:", currentName);
    if (name && name.trim()) {
      dispatch({ type: "RENAME_STASH", stashId: id, name: name.trim() });
    }
  }

  function handleDeleteStash(id: string) {
    if (confirm("Delete this stash? Cards won't be deleted.")) {
      dispatch({ type: "DELETE_STASH", stashId: id });
    }
  }

  return (
    <nav
      aria-label="Filter cards"
      className="border-b border-border bg-background/80"
    >
      <div
        ref={scrollRef}
        className="max-w-2xl mx-auto px-4 py-2 flex items-center gap-2 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: "none" }}
      >
        {/* All pill */}
        <Pill
          label="All"
          count={allCards.length}
          active={isActive({ type: "all" })}
          onClick={() => setFilter({ type: "all" })}
        />

        {/* AI Daily pill — only when the backend delivered cards */}
        {aiCount > 0 && (
          <Pill
            label="✨ AI Daily"
            count={aiCount}
            active={isActive({ type: "ai-today" })}
            onClick={() => setFilter({ type: "ai-today" })}
          />
        )}

        {/* Tag pills */}
        {allTags.map((tag) => {
          const count = allCards.filter((c) => c.tags.includes(tag)).length;
          if (count === 0) return null;
          return (
            <Pill
              key={tag}
              label={tag}
              count={count}
              active={isActive({ type: "tag", tag })}
              onClick={() => setFilter({ type: "tag", tag })}
            />
          );
        })}

        {/* Stash pills */}
        {data.stashes.length > 0 && (
          <div className="w-px h-5 bg-border shrink-0 mx-1" aria-hidden />
        )}
        {data.stashes.map((stash) => (
          <StashPill
            key={stash.id}
            id={stash.id}
            name={stash.name}
            count={stash.cardIds.filter((id) => knownCardIds.has(id)).length}
            active={isActive({ type: "stash", stashId: stash.id })}
            onClick={() => setFilter({ type: "stash", stashId: stash.id })}
            onRename={() => handleRenameStash(stash.id, stash.name)}
            onDelete={() => handleDeleteStash(stash.id)}
          />
        ))}
      </div>
    </nav>
  );
}

interface PillProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function Pill({ label, count, active, onClick }: PillProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      {label}
      <Badge
        variant={active ? "secondary" : "outline"}
        className={cn("text-[10px] px-1 py-0 h-4 min-w-[1rem] font-normal pointer-events-none")}
      >
        {count}
      </Badge>
    </button>
  );
}

interface StashPillProps {
  id: string;
  name: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function StashPill({ name, count, active, onClick, onRename, onDelete }: StashPillProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center shrink-0">
      <button
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          "flex items-center gap-1.5 px-3 py-1 rounded-l-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
      >
        📚 {name}
        <Badge
          variant={active ? "secondary" : "outline"}
          className="text-[10px] px-1 py-0 h-4 min-w-[1rem] font-normal pointer-events-none"
        >
          {count}
        </Badge>
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          className={cn(
            "inline-flex h-7 w-5 items-center justify-center rounded-l-none rounded-r-full px-0.5 text-sm font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
          aria-label={`Options for stash ${name}`}
        >
          <MoreHorizontal className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onRename}>Rename stash</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            Delete stash
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
