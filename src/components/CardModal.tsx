"use client";

import { useState, useEffect, useRef } from "react";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/context/AppContext";
import { Card } from "@/lib/types";
import { CardFormSchema } from "@/lib/schemas";
import { countWords } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const DEFAULT_TAGS = ["Mindset", "Productivity", "Tech", "Finance", "Creativity"];
const WORD_SOFT_LIMIT = 150;

interface CardModalProps {
  mode: "create" | "edit";
  card?: Card;
  onClose: () => void;
}

export function CardModal({ mode, card, onClose }: CardModalProps) {
  const { data, dispatch } = useApp();
  const [title, setTitle] = useState(card?.title ?? "");
  const [body, setBody] = useState(card?.body ?? "");
  const [source, setSource] = useState(card?.source ?? "");
  const [tags, setTags] = useState<string[]>(card?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Focus title on open
  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Collect all existing tags from cards for suggestion
  const allTags = Array.from(
    new Set([...DEFAULT_TAGS, ...data.cards.flatMap((c) => c.tags)])
  ).filter((t) => !tags.includes(t));

  const wordCount = countWords(body);
  const overLimit = wordCount > WORD_SOFT_LIMIT;

  function addTag(tag: string) {
    const t = tag.trim();
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    setTags(tags.filter((t) => t !== tag));
  }

  function handleTagInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  }

  function validate() {
    const result = CardFormSchema.safeParse({ title, body, source, tags });
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      const errs: Record<string, string> = {};
      if (flat.title?.[0]) errs.title = flat.title[0];
      if (flat.body?.[0]) errs.body = flat.body[0];
      setErrors(errs);
      return false;
    }
    setErrors({});
    return true;
  }

  function handleSave() {
    if (!validate()) return;

    const now = new Date().toISOString();

    if (mode === "create") {
      const newCard: Card = {
        id: crypto.randomUUID(),
        title: title.trim(),
        body: body.trim(),
        source: source.trim(),
        tags,
        createdAt: now,
        updatedAt: now,
        favorite: false,
        lastReviewedAt: null,
        reviewCount: 0,
        origin: "user",
      };
      dispatch({ type: "ADD_CARD", card: newCard });
    } else if (card) {
      const updated: Card = {
        ...card,
        title: title.trim(),
        body: body.trim(),
        source: source.trim(),
        tags,
        updatedAt: now,
      };
      dispatch({ type: "UPDATE_CARD", card: updated });
    }

    onClose();
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current) onClose();
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 px-0 sm:px-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-modal-title"
    >
      <div
        className="bg-background w-full max-w-lg rounded-t-2xl sm:rounded-2xl border border-border shadow-xl max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-background z-10">
          <h2 id="card-modal-title" className="font-semibold text-base">
            {mode === "create" ? "Add Idea" : "Edit Card"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="card-title">
              Title <span aria-hidden className="text-destructive">*</span>
            </Label>
            <Input
              id="card-title"
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Parkinson's Law"
              aria-required="true"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "title-error" : undefined}
            />
            {errors.title && (
              <p id="title-error" role="alert" className="text-xs text-destructive">
                {errors.title}
              </p>
            )}
          </div>

          {/* Source */}
          <div className="space-y-1.5">
            <Label htmlFor="card-source">Source / Book / Author</Label>
            <Input
              id="card-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. Atomic Habits by James Clear"
            />
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <Label htmlFor="card-tags">Category Tags</Label>
            <div
              className="flex flex-wrap gap-1.5 min-h-[38px] px-3 py-2 rounded-md border border-input bg-transparent focus-within:ring-2 focus-within:ring-ring"
              onClick={() => document.getElementById("card-tags")?.focus()}
            >
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 text-xs">
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    className="hover:text-destructive"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
              <input
                id="card-tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagInputKeyDown}
                placeholder={tags.length === 0 ? "Add tags…" : ""}
                className="flex-1 min-w-[80px] bg-transparent outline-none text-sm"
                aria-label="Add tag (press Enter or comma to confirm)"
                list="tag-suggestions"
              />
              <datalist id="tag-suggestions">
                {allTags.map((t) => <option key={t} value={t} />)}
              </datalist>
            </div>
            {/* Quick-add default tags */}
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_TAGS.filter((t) => !tags.includes(t)).map((t) => (
                <button
                  key={t}
                  onClick={() => addTag(t)}
                  className="text-xs px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:bg-muted transition-colors"
                >
                  + {t}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="card-body">
                Key Takeaway <span aria-hidden className="text-destructive">*</span>
              </Label>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  overLimit ? "text-amber-500 font-medium" : "text-muted-foreground"
                )}
                aria-live="polite"
              >
                {wordCount} words {overLimit && `(soft limit: ${WORD_SOFT_LIMIT})`}
              </span>
            </div>
            <Textarea
              id="card-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your key insight here. Supports **bold**, *italic*, and - lists."
              rows={8}
              aria-required="true"
              aria-invalid={!!errors.body}
              aria-describedby={errors.body ? "body-error" : undefined}
              className="resize-none font-mono text-sm"
            />
            {errors.body && (
              <p id="body-error" role="alert" className="text-xs text-destructive">
                {errors.body}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex gap-3 justify-end sticky bottom-0 bg-background">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>
            {mode === "create" ? <><Plus className="h-4 w-4 mr-1.5" />Add Card</> : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
