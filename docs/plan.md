# "My Stash" — Implementation Plan

**Type:** Mobile-first microlearning PWA (Deepstash-inspired) **Deployment target:** Cloudflare Pages (static export, zero backend) **Stack:** Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Lucide React

---

## 1. Goal & Scope

A single-page microlearning app where users browse bite-sized idea "cards," organize them into custom "stashes" (collections), and review them over time. Entirely client-side. No auth, no server, no database — all data lives in the browser via `localStorage`, with JSON export/import as a manual backup path.

**Out of scope for v1:** accounts, sync across devices, server-side storage, sharing links between users. Flag these as fast-follow if the client asks — the architecture below doesn't block adding a backend later, but don't build for it now.

---

## 2. Tech Stack & Cloudflare Constraints

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js App Router | Must be configured for **static export** |
| Language | TypeScript | Strict mode on |
| Styling | Tailwind CSS |  |
| Components | shadcn/ui | Copy-in components, no runtime dependency issues |
| Icons | Lucide React |  |
| State | React Context + `useReducer` (or Zustand if the dev prefers) | Kept in-memory, synced to `localStorage` |
| Validation | Zod | Schema for cards, stashes, and the localStorage payload itself |
| Animation | Framer Motion or CSS transitions | Keep it light — respect `prefers-reduced-motion` |
| Persistence | `localStorage` | See §5 for schema and safety notes |
| Deployment | Cloudflare Pages | Static export output, no Cloudflare Functions/Workers required for v1 |

### Cloudflare-specific setup requirements

- `next.config.js` must set `output: 'export'`. No API routes, no `getServerSideProps`, no image optimization API (use `unoptimized: true` for `next/image` or avoid it and use plain `<img>`/SVGs).
- Confirm every dependency is compatible with static export — no server components that rely on runtime data fetching, no middleware.
- Cloudflare Pages build settings:
  - Build command: `next build`
  - Output directory: `out`
  - Node version pinned in project settings (match dev's local version, document it in the README).
- Add a `_headers` or `_routes.json` file if needed for PWA service worker caching headers — confirm with Cloudflare Pages docs during setup, since static export + PWA service worker registration needs the right `Cache-Control` on `sw.js` (must not be aggressively cached).
- Test the production build locally with `npx serve out` before every deploy to catch static-export-only bugs (these don't show up in `next dev`).

**Developer action item:** before writing any app code, get a "hello world" Next.js static export deploying to Cloudflare Pages successfully. This de-risks the deployment pipeline early instead of discovering export issues after the app is built.

---

## 3. Data Model

```typescript
type Card = {
  id: string;              // uuid
  title: string;
  body: string;             // markdown-lite (bold/italic/lists only)
  source: string;           // e.g. "Atomic Habits by James Clear"
  tags: string[];           // multiple categories allowed, e.g. ["Mindset", "Productivity"]
  createdAt: string;        // ISO date
  updatedAt: string;
  favorite: boolean;
  lastReviewedAt: string | null;
  reviewCount: number;
};

type Stash = {
  id: string;
  name: string;             // user-created collection, e.g. "Weekend Reading"
  cardIds: string[];
  createdAt: string;
};

type AppData = {
  schemaVersion: number;    // for future migrations
  cards: Card[];
  stashes: Stash[];
  settings: {
    theme: "light" | "dark" | "system";
  };
};
```

- Predefined category tags ("Mindset", "Productivity", "Tech", "Finance", "Creativity") are just default tag values — not a separate type. Custom stashes are structurally different from tags (a stash is a named collection of card IDs; a tag is a filter label on a card). Don't conflate them in the UI or the data model.
- `schemaVersion` is mandatory from day one — even though there's only one version now, retrofitting migration logic later on live user data is much harder than starting with it.

---

## 4. Feature Breakdown

### 4.1 Top Header

- App title "My Stash" + bookmark/sparkle icon (Lucide).
- Search icon → expands to a debounced (≈250ms) search input filtering cards by title/body/source.
- "Add Idea" button → opens the create modal (§4.4).
- Theme toggle: light/dark/system, persisted in `settings.theme`.

### 4.2 Categories / Stashes Filter Bar

- Horizontally scrollable pill row: "All" + default tags + any tags the user has introduced via card creation.
- Tapping a pill filters the active card feed by tag (a card with multiple tags appears under each).
- Separate "My Stashes" section/pill showing user-created collections with a card count badge; tapping opens a filtered view of just that stash's cards.
- Long-press (mobile) / right-click (desktop) on a custom stash → rename or delete, with a confirm dialog before delete.

### 4.3 Main Card Deck / Reader

- Centered card, `max-w-md` (mobile) / `max-w-lg` (desktop).
- **Navigation:**
  - Swipe left/right on touch devices, with the card visually following the drag and snapping back or completing the transition past a threshold.
  - Left/Right arrow keys on desktop.
  - Prev/Next buttons.
  - Counter, e.g. "3 of 12", reflecting the current filtered set.
- **Card header:** tag badge(s), auto-calculated read time (`Math.ceil(wordCount / 200)` minute estimate is fine), source line.
- **Card body:** bold title, 2–4 short paragraphs rendered from stored markdown-lite (support **bold**, *italic*, and lists only — don't pull in a full markdown renderer dependency for this).
- **Card footer:**
  - Favorite toggle (persists immediately).
  - "Stash to..." popover: multi-select existing stashes, or type a new name to create one inline.
  - Overflow menu (kebab icon): Edit (opens §4.4 pre-filled), Delete (confirm dialog required), Copy as text.
  - Prev/Next + counter (can be same row as swipe area on mobile).
- **Sort/filter controls** above the deck: Newest, Favorites only, Most revisited (`reviewCount` descending).
- **Empty state:** when a filter or search returns zero cards, show a clear message with a "Clear filters" action — don't show a blank card area.

### 4.4 Add / Edit Idea Modal

- One modal, two modes (create / edit), pre-filled on edit.
- Fields:
  - Title (required)
  - Source / Book / Author (optional)
  - Category tags — multi-select combobox, allow creating new tags inline
  - Key Takeaway body (multiline textarea, markdown-lite)
- Live word counter with a soft visual warning past \~150 words (not a hard block).
- Zod validation: title and body required, inline error messages, no silent failures.
- On save: prepend to `cards`, persist to `localStorage`, close modal, jump the deck to the newly created/edited card.

### 4.5 Daily Review Mode

This is the retention mechanic — don't cut it, it's what separates this from a static list.

- Separate entry point (button/tab) from the main browse deck.
- Pulls a small batch (e.g. 5–10) of cards weighted toward: not reviewed recently (`lastReviewedAt` oldest first) and favorites.
- No need for full spaced-repetition scheduling (SM-2, etc.) in v1 — a simple recency + favorite weighting is enough. Document this as a clearly-labeled simplification so the client doesn't expect Anki-level scheduling.
- Viewing a card in Review Mode updates `lastReviewedAt` and increments `reviewCount`.

### 4.6 Data Safety: Export / Import

- Settings menu (or a small icon in the header) with:
  - **Export**: downloads current `AppData` as a timestamped `.json` file.
  - **Import**: file picker, validates against the Zod schema before applying, shows a confirm dialog since it will overwrite current data (or offer merge vs. replace — merge is nicer but replace is acceptable for v1 if time-constrained; flag the choice to the client).
- This is the only backup path since there's no backend — treat it as required, not optional polish.

### 4.7 PWA / Offline

- Web app manifest (name, icons, theme color, `display: standalone`).
- Service worker for offline asset caching (Workbox or Next's PWA plugin — confirm whichever is chosen works cleanly with static export).
- Should be installable on mobile home screen and function offline after first load, since all data is local anyway.

---

## 5. Persistence Details

- Read/write `localStorage` through a single thin wrapper module — don't scatter `localStorage.getItem`/`setItem` calls across components. This makes the schema-version migration path and the export/import feature much easier to implement correctly.
- Debounce writes (e.g. 300–500ms after last state change) rather than writing on every keystroke in the edit modal.
- Wrap all `localStorage` reads in try/catch — private browsing mode, storage quota errors, and corrupted JSON should degrade gracefully (fall back to seed data, don't crash the app).
- On load: validate stored data against the Zod schema; if it fails validation, don't silently wipe it — show the user a message and offer to export the raw broken data before resetting, if feasible in the time budget.

---

## 6. Seed Data

Pre-populate on first load (when no existing `localStorage` data is found) with 6–8 realistic cards, tagged across multiple categories to demonstrate the multi-tag system:

1. Parkinson's Law — *Productivity*
2. The Power of Compounding — *Finance, Mindset*
3. The Inversion Principle — *Mindset, Productivity*
4. The Eisenhower Matrix — *Productivity*
5. Loss Aversion — *Finance, Mindset*
6. Second-Order Thinking — *Mindset, Tech*
7. (optional) The 2-Minute Rule — *Productivity*
8. (optional) Occam's Razor — *Mindset, Tech*

Each under 150 words, with a real or plausible source attribution.

---

## 7. Design Direction

- Editorial, Substack-Reader feel: generous whitespace, clear typographic hierarchy (distinct treatment for headline vs. body — a serif/sans pairing works well but isn't mandatory), subtle borders instead of heavy dividers, soft shadows over hard drop shadows.
- Restrained motion: card transitions should feel smooth but quick (150–250ms), and everything must respect `prefers-reduced-motion`.
- Full keyboard navigability and ARIA labeling on the modal, buttons, and filter pills — this isn't a nice-to-have, treat it as a acceptance criterion.

---

## 8. Suggested Build Order

1. Cloudflare Pages static export pipeline working end-to-end (empty app).
2. Data layer: types, Zod schemas, localStorage wrapper, seed data loading.
3. Card deck UI (read-only) with filter pills and navigation (keyboard first, then swipe).
4. Add/Edit modal + persistence round-trip.
5. Stashes: create/rename/delete, "Stash to..." popover, stash-filtered view.
6. Favorites, search, sort controls.
7. Review Mode.
8. Export/Import.
9. PWA manifest + service worker.
10. Theming (light/dark/system), accessibility pass, motion polish.
11. Final production-build test against Cloudflare Pages before handoff.

---

## 9. Acceptance Criteria Checklist

- [ ] Static export builds cleanly and deploys to Cloudflare Pages with no server dependency
- [ ] Cards and stashes persist across a hard refresh and a browser restart
- [ ] Cards support multiple tags; filter pills reflect this correctly
- [ ] Swipe gestures work on mobile; arrow keys work on desktop
- [ ] Add/Edit modal validates input and updates the deck immediately on save
- [ ] Delete actions (card, stash) require confirmation
- [ ] Review Mode surfaces a distinct, weighted subset of cards and updates review metadata
- [ ] Export produces a valid JSON file; Import round-trips it correctly
- [ ] App is installable as a PWA and loads offline after first visit
- [ ] Light/dark/system theme toggle works and persists
- [ ] Keyboard navigation and ARIA labels present on all interactive elements
- [ ] App loads with seed data on first run, with no console errors