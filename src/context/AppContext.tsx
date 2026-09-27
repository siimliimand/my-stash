"use client";

import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef } from "react";
import { AppData, Card, Stash, SortMode, FilterMode } from "@/lib/types";
import { readStorage, writeStorage, writeStorageImmediate } from "@/lib/storage";
import { createSeedData } from "@/lib/seed";
import { fetchTodayCards, fetchArchiveCards, isApiConfigured } from "@/lib/api";
import {
  AiCardOverrides,
  EMPTY_AI_OVERRIDES,
  applyAiOverrides,
  readAiOverrides,
  writeAiOverrides,
  readPersistedAiCards,
  writePersistedAiCards,
} from "@/lib/aiState";

// One-time archive backfill guard: survives StrictMode's double-mounted
// effects in dev so the paginated history sync never runs twice in parallel
// (MERGE dedupes anyway — this just avoids duplicate requests).
let archiveSyncStarted = false;

// ─── State ────────────────────────────────────────────────────────────────────

type AppState = {
  data: AppData;
  aiCards: Card[]; // accumulated AI-card archive, persisted to its own key
  aiOverrides: AiCardOverrides; // user actions on AI cards, persisted separately
  filter: FilterMode;
  sortMode: SortMode;
  searchQuery: string;
  currentIndex: number;
  isLoaded: boolean;
  storageError: boolean;
  corruptedRaw: string | null;
};

// ─── Actions ──────────────────────────────────────────────────────────────────

type Action =
  | { type: "INIT"; data: AppData }
  | { type: "STORAGE_ERROR"; raw: string | null }
  | { type: "ADD_CARD"; card: Card }
  | { type: "UPDATE_CARD"; card: Card }
  | { type: "DELETE_CARD"; cardId: string }
  | { type: "TOGGLE_FAVORITE"; cardId: string }
  | { type: "MARK_REVIEWED"; cardId: string }
  | { type: "ADD_STASH"; stash: Stash }
  | { type: "RENAME_STASH"; stashId: string; name: string }
  | { type: "DELETE_STASH"; stashId: string }
  | { type: "STASH_CARD"; cardId: string; stashId: string }
  | { type: "UNSTASH_CARD"; cardId: string; stashId: string }
  | { type: "SET_FILTER"; filter: FilterMode }
  | { type: "SET_SORT"; sort: SortMode }
  | { type: "SET_SEARCH"; query: string }
  | { type: "SET_INDEX"; index: number }
  | { type: "SET_THEME"; theme: "light" | "dark" | "system" }
  | { type: "SET_AI_CARDS"; cards: Card[] }
  | { type: "MERGE_AI_CARDS"; cards: Card[] }
  | { type: "SET_AI_OVERRIDES"; overrides: AiCardOverrides };

// AI card = delivered by the API and not also a user card with that id
function isAiCard(state: AppState, cardId: string): boolean {
  return (
    state.aiCards.some((c) => c.id === cardId) &&
    !state.data.cards.some((c) => c.id === cardId)
  );
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "INIT":
      return { ...state, data: action.data, isLoaded: true };

    case "STORAGE_ERROR":
      return { ...state, isLoaded: true, storageError: true, corruptedRaw: action.raw };

    case "SET_AI_CARDS":
      return { ...state, aiCards: action.cards };

    // Union by id — existing entries win, unseen cards are appended. Returns
    // the same state object when nothing is new so the persistence effect
    // (identity-checked) skips redundant writes.
    case "MERGE_AI_CARDS": {
      const known = new Map(state.aiCards.map((c) => [c.id, c] as const));
      let added = false;
      for (const card of action.cards) {
        if (!known.has(card.id)) {
          known.set(card.id, card);
          added = true;
        }
      }
      if (!added) return state;
      return { ...state, aiCards: [...known.values()] };
    }

    case "SET_AI_OVERRIDES":
      return { ...state, aiOverrides: action.overrides };

    case "ADD_CARD": {
      const cards = [action.card, ...state.data.cards];
      return {
        ...state,
        currentIndex: 0,
        data: { ...state.data, cards },
      };
    }

    case "UPDATE_CARD": {
      if (isAiCard(state, action.card.id)) {
        const edits = {
          ...state.aiOverrides.edits,
          [action.card.id]: {
            title: action.card.title,
            body: action.card.body,
            source: action.card.source,
            tags: action.card.tags,
          },
        };
        return { ...state, aiOverrides: { ...state.aiOverrides, edits } };
      }
      const cards = state.data.cards.map((c) =>
        c.id === action.card.id ? action.card : c
      );
      return { ...state, data: { ...state.data, cards } };
    }

    case "DELETE_CARD": {
      if (isAiCard(state, action.cardId)) {
        const deleted = state.aiOverrides.deleted.includes(action.cardId)
          ? state.aiOverrides.deleted
          : [...state.aiOverrides.deleted, action.cardId];
        const stashes = state.data.stashes.map((s) => ({
          ...s,
          cardIds: s.cardIds.filter((id) => id !== action.cardId),
        }));
        return {
          ...state,
          aiOverrides: { ...state.aiOverrides, deleted },
          data: { ...state.data, stashes },
          currentIndex: 0,
        };
      }
      const cards = state.data.cards.filter((c) => c.id !== action.cardId);
      const stashes = state.data.stashes.map((s) => ({
        ...s,
        cardIds: s.cardIds.filter((id) => id !== action.cardId),
      }));
      return { ...state, data: { ...state.data, cards, stashes }, currentIndex: 0 };
    }

    case "TOGGLE_FAVORITE": {
      if (isAiCard(state, action.cardId)) {
        const favorites = state.aiOverrides.favorites.includes(action.cardId)
          ? state.aiOverrides.favorites.filter((id) => id !== action.cardId)
          : [...state.aiOverrides.favorites, action.cardId];
        return { ...state, aiOverrides: { ...state.aiOverrides, favorites } };
      }
      const cards = state.data.cards.map((c) =>
        c.id === action.cardId ? { ...c, favorite: !c.favorite } : c
      );
      return { ...state, data: { ...state.data, cards } };
    }

    case "MARK_REVIEWED": {
      if (isAiCard(state, action.cardId)) {
        const prev = state.aiOverrides.reviews[action.cardId];
        const reviews = {
          ...state.aiOverrides.reviews,
          [action.cardId]: {
            lastReviewedAt: new Date().toISOString(),
            reviewCount: (prev?.reviewCount ?? 0) + 1,
          },
        };
        return { ...state, aiOverrides: { ...state.aiOverrides, reviews } };
      }
      const cards = state.data.cards.map((c) =>
        c.id === action.cardId
          ? { ...c, lastReviewedAt: new Date().toISOString(), reviewCount: c.reviewCount + 1 }
          : c
      );
      return { ...state, data: { ...state.data, cards } };
    }

    case "ADD_STASH": {
      const stashes = [...state.data.stashes, action.stash];
      return { ...state, data: { ...state.data, stashes } };
    }

    case "RENAME_STASH": {
      const stashes = state.data.stashes.map((s) =>
        s.id === action.stashId ? { ...s, name: action.name } : s
      );
      return { ...state, data: { ...state.data, stashes } };
    }

    case "DELETE_STASH": {
      const stashes = state.data.stashes.filter((s) => s.id !== action.stashId);
      const filter: FilterMode =
        state.filter.type === "stash" && state.filter.stashId === action.stashId
          ? { type: "all" }
          : state.filter;
      return { ...state, data: { ...state.data, stashes }, filter };
    }

    case "STASH_CARD": {
      const stashes = state.data.stashes.map((s) =>
        s.id === action.stashId && !s.cardIds.includes(action.cardId)
          ? { ...s, cardIds: [...s.cardIds, action.cardId] }
          : s
      );
      return { ...state, data: { ...state.data, stashes } };
    }

    case "UNSTASH_CARD": {
      const stashes = state.data.stashes.map((s) =>
        s.id === action.stashId
          ? { ...s, cardIds: s.cardIds.filter((id) => id !== action.cardId) }
          : s
      );
      return { ...state, data: { ...state.data, stashes } };
    }

    case "SET_FILTER":
      return { ...state, filter: action.filter, currentIndex: 0 };

    case "SET_SORT":
      return { ...state, sortMode: action.sort, currentIndex: 0 };

    case "SET_SEARCH":
      return { ...state, searchQuery: action.query, currentIndex: 0 };

    case "SET_INDEX":
      return { ...state, currentIndex: action.index };

    case "SET_THEME": {
      return {
        ...state,
        data: { ...state.data, settings: { ...state.data.settings, theme: action.theme } },
      };
    }

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

type AppContextValue = AppState & {
  dispatch: React.Dispatch<Action>;
  allCards: Card[];
  filteredCards: Card[];
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    data: {
      schemaVersion: 1,
      cards: [],
      stashes: [],
      settings: { theme: "system" },
    },
    aiCards: [],
    aiOverrides: EMPTY_AI_OVERRIDES,
    filter: { type: "all" },
    sortMode: "newest",
    searchQuery: "",
    currentIndex: 0,
    isLoaded: false,
    storageError: false,
    corruptedRaw: null,
  });

  // Load data from localStorage on mount
  useEffect(() => {
    const overrides = readAiOverrides();
    if (overrides !== EMPTY_AI_OVERRIDES) {
      dispatch({ type: "SET_AI_OVERRIDES", overrides });
    }

    const stored = readStorage();
    if (stored) {
      dispatch({ type: "INIT", data: stored });
    } else {
      // Check for corrupted data
      try {
        const raw = localStorage.getItem("my-stash-data");
        if (raw) {
          // there is data but it's invalid
          dispatch({ type: "STORAGE_ERROR", raw });
        } else {
          // first time — load seed data
          const seed = createSeedData();
          dispatch({ type: "INIT", data: seed });
          writeStorageImmediate(seed);
        }
      } catch {
        const seed = createSeedData();
        dispatch({ type: "INIT", data: seed });
        writeStorageImmediate(seed);
      }
    }

    // Hydrate the accumulated AI-card archive from localStorage — instant,
    // no network. null means nothing stored yet (first run on this device).
    const storedAiCards = readPersistedAiCards();
    if (storedAiCards !== null) {
      dispatch({ type: "SET_AI_CARDS", cards: storedAiCards });
    }

    // Background sync — never blocks first paint and never loads the whole
    // database at once: today's small batch first, then (first run only) the
    // server archive backfilled one 50-card page at a time, merged as each
    // page lands. Steady state afterwards: one small request per day.
    if (isApiConfigured()) {
      let cancelled = false;
      const merge = (cards: Card[]) => {
        if (!cancelled && cards.length > 0) {
          dispatch({ type: "MERGE_AI_CARDS", cards });
        }
      };
      fetchTodayCards().then(merge);
      if (storedAiCards === null && !archiveSyncStarted) {
        archiveSyncStarted = true;
        void fetchArchiveCards(merge);
      }
      return () => {
        cancelled = true;
      };
    }
  }, []);

  // Persist to localStorage whenever data changes
  const prevDataRef = useRef(state.data);
  useEffect(() => {
    if (!state.isLoaded) return;
    if (state.data === prevDataRef.current) return;
    prevDataRef.current = state.data;
    writeStorage(state.data);
  }, [state.isLoaded, state.data]);

  // Persist AI-card overrides to their own localStorage key
  const prevAiOverridesRef = useRef(state.aiOverrides);
  useEffect(() => {
    if (!state.isLoaded) return;
    if (state.aiOverrides === prevAiOverridesRef.current) return;
    prevAiOverridesRef.current = state.aiOverrides;
    writeAiOverrides(state.aiOverrides);
  }, [state.isLoaded, state.aiOverrides]);

  // Persist the AI-card archive to its own localStorage key
  const prevAiCardsRef = useRef(state.aiCards);
  useEffect(() => {
    if (state.aiCards === prevAiCardsRef.current) return;
    prevAiCardsRef.current = state.aiCards;
    writePersistedAiCards(state.aiCards);
  }, [state.aiCards]);

  // Apply theme
  useEffect(() => {
    if (!state.isLoaded) return;
    const root = document.documentElement;
    const theme = state.data.settings.theme;
    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      // system
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.matches) root.classList.add("dark");
      else root.classList.remove("dark");
    }
  }, [state.isLoaded, state.data.settings.theme]);

  // Merged view: user cards + accumulated AI cards with user overrides applied
  const allCards = useMemo(
    () => [...state.data.cards, ...applyAiOverrides(state.aiCards, state.aiOverrides)],
    [state.data.cards, state.aiCards, state.aiOverrides]
  );

  // Compute filtered + sorted card list
  const filteredCards = useCallback(() => {
    let cards = [...allCards];

    // Filter by active filter mode
    const filter = state.filter;
    if (filter.type === "tag") {
      cards = cards.filter((c) => c.tags.includes(filter.tag));
    } else if (filter.type === "stash") {
      const stash = state.data.stashes.find((s) => s.id === filter.stashId);
      if (stash) {
        const idSet = new Set(stash.cardIds);
        cards = cards.filter((c) => idSet.has(c.id));
      }
    } else if (filter.type === "ai-today") {
      cards = cards.filter((c) => c.origin === "ai");
    }

    // Filter by search
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase();
      cards = cards.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.body.toLowerCase().includes(q) ||
          c.source.toLowerCase().includes(q)
      );
    }

    // Sort
    if (state.sortMode === "newest") {
      cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else if (state.sortMode === "favorites") {
      cards = cards.filter((c) => c.favorite);
    } else if (state.sortMode === "most-reviewed") {
      cards.sort((a, b) => b.reviewCount - a.reviewCount);
    }

    return cards;
  }, [allCards, state.data.stashes, state.filter, state.searchQuery, state.sortMode]);

  return (
    <AppContext.Provider
      value={{
        ...state,
        dispatch,
        allCards,
        filteredCards: filteredCards(),
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
