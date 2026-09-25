# My Stash

A mobile-first microlearning PWA — browse, save, and review bite-sized idea cards. Entirely client-side, no backend required.

## Stack

- **Next.js 16** (App Router, static export)
- **TypeScript** (strict mode)
- **Tailwind CSS v4**
- **shadcn/ui v4** (base-ui components)
- **Lucide React** (icons)
- **Framer Motion** (card swipe & transitions)
- **Zod** (runtime validation)

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
# Output goes to: out/
```

> Preview locally with: `npx serve out`

## Cloudflare Pages Deployment

| Setting | Value |
|---|---|
| Build command | `next build` |
| Output directory | `out` |
| Node version | `22` |

The `public/_headers` file sets `Cache-Control: no-cache` on `sw.js` so the service worker is always refreshed.

## AI Daily cards (optional backend)

A companion Cloudflare Worker can deliver a daily batch of AI-generated cards (see [`docs/ai-backend-plan.md`](docs/ai-backend-plan.md)).

- Set `NEXT_PUBLIC_API_URL` (e.g. `https://my-stash-api.workers.dev`) at **build** time — see `.env.example`.
- If the variable is unset or the API is unreachable, the feature silently disables: no network calls, no AI pill, everything else unchanged.
- AI cards are not persisted; only your interactions with them (favorites, reviews, edits, deletions) are kept locally under the `my-stash-ai-state` localStorage key.

## Node Version

Node 22 (see `.node-version` if pinned).

## Features

- 📚 **Card deck** — swipe left/right on mobile, arrow keys on desktop
- 🔍 **Search** — debounced full-text search across title/body/source
- 🏷️ **Tags + stashes** — filter by tags or user-created collections
- ⭐ **Favorites** — quick-access heart toggle
- ✨ **Daily Review Mode** — weighted review session (recency + favorites)
- 💾 **localStorage persistence** — debounced writes, Zod-validated reads
- 📤 **Export / Import** — JSON backup/restore
- 🌙 **Light/dark/system theme**
- 📱 **PWA** — installable, works offline after first load
- ♿ **Accessible** — ARIA labels, keyboard navigation throughout
