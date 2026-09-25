export type Card = {
  id: string;
  title: string;
  body: string; // markdown-lite (bold/italic/lists only)
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
  lastReviewedAt: string | null;
  reviewCount: number;
};

export type Stash = {
  id: string;
  name: string;
  cardIds: string[];
  createdAt: string;
};

export type AppData = {
  schemaVersion: number;
  cards: Card[];
  stashes: Stash[];
  settings: {
    theme: "light" | "dark" | "system";
  };
};

export type SortMode = "newest" | "favorites" | "most-reviewed";
export type FilterMode = { type: "tag"; tag: string } | { type: "stash"; stashId: string } | { type: "all" };
