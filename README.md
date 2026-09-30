# My Stash

A mobile-first microlearning PWA — browse, save, and review bite-sized idea cards. Entirely client-side (no account, no database); an optional Cloudflare Worker backend adds daily AI-generated cards.

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

## Production Build & Deploy

**Deploy to Cloudflare Pages (the only supported way to ship production):**

```bash
npm run deploy:web
```

This single command builds with the production API URL forced via `process.env`
(highest precedence — it beats any `.env*` file), verifies the built artifact
in `out/`, and uploads to Pages. Never run `next build` + manual
`wrangler pages deploy` — that is how a `localhost` API URL got baked into
production on 2026-09-29 (see "Build guards" below).

**Local static-export test build** (serves with the local dev API URL):

```bash
ALLOW_LOCAL_API=1 npm run build   # or: npm run build:local
npx serve out
```

### Build guards (why plain `next build` can fail)

`NEXT_PUBLIC_*` vars are inlined into the client bundle at **build** time, and
`.env.local` overrides `.env.production` — so a build on the dev machine
silently ships `http://localhost:8787` unless guarded. Two scripts enforce it:

1. `scripts/check-build-env.mjs` (`prebuild`) — resolves `NEXT_PUBLIC_API_URL`
   exactly as Next.js does (`@next/env`) and **blocks the build** if it is
   unset, not `https://`, or localhost. Escape hatch for local builds:
   `ALLOW_LOCAL_API=1`.
2. `scripts/verify-build-output.mjs` (runs inside `deploy:web` before upload) —
   scans the built `out/` artifacts and **refuses to deploy** if any
   localhost URL is inlined, or if the expected production URL was NOT inlined
   (silent env dropout). Cannot be bypassed on the deploy path.

If `npm run build` fails with "BUILD BLOCKED", that is intentional — use
`npm run deploy:web` for production or `ALLOW_LOCAL_API=1` for local tests.

## Cloudflare Pages Deployment

| Setting | Value |
|---|---|
| Project | `my-stash` (direct upload — no git integration; deploys happen from this repo via `npm run deploy:web`) |
| Output directory | `out` |
| Node version | `22` |

The `public/_headers` file sets `Cache-Control: no-cache` on `sw.js` so the service worker is always refreshed. The service worker itself (v2) fetches navigations **network-first** — a deployed update lands on the very next launch while online, with the cached app shell serving only as the offline fallback; hashed static assets are cache-first.

## AI Daily cards (optional backend)

A companion Cloudflare Worker can deliver a daily batch of AI-generated cards (see [`workers/README.md`](workers/README.md), plan in [`docs/ai-backend-plan.md`](docs/ai-backend-plan.md)).

- Production API: `https://my-stash-api.siim-liimand.workers.dev` (note: the account's workers.dev subdomain is `siim-liimand`; older docs saying `my-stash-api.workers.dev` do not resolve).
- Set `NEXT_PUBLIC_API_URL` at **build** time — in practice always via `npm run deploy:web`, which forces the correct URL regardless of `.env` files.
- If the variable is unset or the API is unreachable, the feature silently disables: no network calls, no AI pill, everything else unchanged.
- AI cards accumulate on the device: every delivered card is kept in localStorage (`my-stash-ai-cards`), so past daily batches stay in your deck. Sync is incremental — one small request for today's batch per day, plus a one-time paginated backfill of the server archive (50 cards per request) on first run. The server is never queried for the whole history in a single request.
- Your interactions with AI cards (favorites, reviews, edits, deletions) are kept locally under the `my-stash-ai-state` localStorage key and re-applied on load.
- The **AI Daily** filter/pill counts only the most recent batch; older accumulated batches stay reachable via All / tags / search.

## Node Version

Node 22 (see `.node-version` if pinned).

## Features

- 📚 **Card deck** — swipe left/right on mobile, arrow keys on desktop
- 🔍 **Search** — debounced full-text search across title/body/source
- 🏷️ **Tags + stashes** — filter by tags or user-created collections
- ⭐ **Favorites** — quick-access heart toggle
- ✨ **Daily Review Mode** — weighted review session (recency + favorites)
- 🔊 **Read aloud** — text-to-speech via the Web Speech API (speaker button on card deck & review; markdown stripped, long cards queued as sentence-sized chunks; hidden where unsupported)
- 💾 **localStorage persistence** — debounced writes, Zod-validated reads
- 📤 **Export / Import** — JSON backup/restore
- 🌙 **Light/dark/system theme**
- 📱 **PWA** — installable, works offline after first load
- ♿ **Accessible** — ARIA labels, keyboard navigation throughout
