"use client";

import { useState } from "react";
import { Plus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useApp } from "@/context/AppContext";
import { cn } from "@/lib/utils";

interface StashPopoverProps {
  cardId: string;
}

export function StashPopover({ cardId }: StashPopoverProps) {
  const { data, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");

  function isInStash(stashId: string): boolean {
    return data.stashes.find((s) => s.id === stashId)?.cardIds.includes(cardId) ?? false;
  }

  function toggleStash(stashId: string) {
    if (isInStash(stashId)) {
      dispatch({ type: "UNSTASH_CARD", cardId, stashId });
    } else {
      dispatch({ type: "STASH_CARD", cardId, stashId });
    }
  }

  function createStash() {
    if (!newName.trim()) return;
    const stash = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      cardIds: [cardId],
      createdAt: new Date().toISOString(),
    };
    dispatch({ type: "ADD_STASH", stash });
    setNewName("");
  }

  const stashedCount = data.stashes.filter((s) => s.cardIds.includes(cardId)).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-xs font-medium transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Add to stash"
      >
        📚
        {stashedCount > 0 && (
          <span className="text-xs text-muted-foreground">({stashedCount})</span>
        )}
        <span className="hidden sm:inline">Stash to</span>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-3 space-y-2"
        align="start"
        role="dialog"
        aria-label="Add to stash"
      >
        <p className="text-xs font-medium text-muted-foreground mb-2">Add to stash</p>

        {data.stashes.length === 0 && (
          <p className="text-xs text-muted-foreground py-1">No stashes yet — create one below.</p>
        )}

        {data.stashes.map((stash) => {
          const active = isInStash(stash.id);
          return (
            <button
              key={stash.id}
              onClick={() => toggleStash(stash.id)}
              aria-pressed={active}
              className={cn(
                "w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted text-foreground"
              )}
            >
              <span className="truncate">{stash.name}</span>
              {active && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}

        {/* Create new stash */}
        <div className="flex gap-1.5 pt-1 border-t border-border">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New stash name…"
            className="h-7 text-xs"
            aria-label="New stash name"
            onKeyDown={(e) => e.key === "Enter" && createStash()}
          />
          <Button
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={createStash}
            disabled={!newName.trim()}
            aria-label="Create stash"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
