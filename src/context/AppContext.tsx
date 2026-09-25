"use client";

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from "react";
import { AppData, Card, Stash, SortMode, FilterMode } from "@/lib/types";
import { readStorage, writeStorage, writeStorageImmediate } from "@/lib/storage";
import { createSeedData } from "@/lib/seed";

// ─── State ────────────────────────────────────────────────────────────────────

type AppState = {
  data: AppData;
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
  | { type: "SET_THEME"; theme: "light" | "dark" | "system" };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "INIT":
      return { ...state, data: action.data, isLoaded: true };

    case "STORAGE_ERROR":
      return { ...state, isLoaded: true, storageError: true, corruptedRaw: action.raw };

    case "ADD_CARD": {
      const cards = [action.card, ...state.data.cards];
      return {
        ...state,
        currentIndex: 0,
        data: { ...state.data, cards },
      };
    }

    case "UPDATE_CARD": {
      const cards = state.data.cards.map((c) =>
        c.id === action.card.id ? action.card : c
      );
      return { ...state, data: { ...state.data, cards } };
    }

    case "DELETE_CARD": {
      const cards = state.data.cards.filter((c) => c.id !== action.cardId);
      const stashes = state.data.stashes.map((s) => ({
        ...s,
        cardIds: s.cardIds.filter((id) => id !== action.cardId),
      }));
      return { ...state, data: { ...state.data, cards, stashes }, currentIndex: 0 };
    }

    case "TOGGLE_FAVORITE": {
      const cards = state.data.cards.map((c) =>
        c.id === action.cardId ? { ...c, favorite: !c.favorite } : c
      );
      return { ...state, data: { ...state.data, cards } };
    }

    case "MARK_REVIEWED": {
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
  }, []);

  // Persist to localStorage whenever data changes
  const prevDataRef = useRef(state.data);
  useEffect(() => {
    if (!state.isLoaded) return;
    if (state.data === prevDataRef.current) return;
    prevDataRef.current = state.data;
    writeStorage(state.data);
  }, [state.isLoaded, state.data]);

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

  // Compute filtered + sorted card list
  const filteredCards = useCallback(() => {
    let cards = [...state.data.cards];

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
  }, [state.data.cards, state.data.stashes, state.filter, state.searchQuery, state.sortMode]);

  return (
    <AppContext.Provider
      value={{
        ...state,
        dispatch,
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
