"use client";

import { useState } from "react";
import { Header } from "@/components/Header";
import { FilterBar } from "@/components/FilterBar";
import { CardDeck } from "@/components/CardDeck";
import { ReviewMode } from "@/components/ReviewMode";
import { useApp } from "@/context/AppContext";

export default function Home() {
  const [reviewOpen, setReviewOpen] = useState(false);
  const { isLoaded, storageError, corruptedRaw, dispatch } = useApp();

  if (!isLoaded) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin" aria-hidden />
          <span className="text-sm">Loading your stash…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col">
      <Header onOpenReview={() => setReviewOpen(true)} />
      <FilterBar />

      {storageError && (
        <div role="alert" className="max-w-2xl mx-auto w-full px-4 py-3">
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-sm space-y-2">
            <p className="font-medium text-amber-900 dark:text-amber-200">⚠️ Corrupted data detected</p>
            <p className="text-amber-800 dark:text-amber-300 text-xs">
              Your saved data couldn't be parsed. Starting fresh with seed data. You can export the raw backup below if needed.
            </p>
            <div className="flex gap-2">
              {corruptedRaw && (
                <button
                  onClick={() => {
                    const blob = new Blob([corruptedRaw], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "my-stash-corrupted-backup.json";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="text-xs underline text-amber-700 dark:text-amber-400"
                >
                  Download raw backup
                </button>
              )}
              <button
                onClick={() => dispatch({ type: "SET_FILTER", filter: { type: "all" } })}
                className="text-xs underline text-amber-700 dark:text-amber-400"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col">
        <CardDeck />
      </main>

      {reviewOpen && (
        <ReviewMode onClose={() => setReviewOpen(false)} />
      )}
    </div>
  );
}
