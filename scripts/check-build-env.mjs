#!/usr/bin/env node
/**
 * Prebuild guard: fails `npm run build` unless NEXT_PUBLIC_API_URL resolves to
 * the production HTTPS API.
 *
 * WHY: NEXT_PUBLIC_* variables are INLINED INTO THE BUNDLE at build time. The
 * 2026-09-29 incident: a `next build` run on the dev machine picked up
 * `.env.local` (NEXT_PUBLIC_API_URL=http://localhost:8787 — higher precedence
 * than any .env.production), the bundle shipped with localhost baked in, every
 * visitor's fetch failed silently, and the site degraded to localStorage-only
 * mode — days of cron-generated cards never appeared.
 *
 * This script resolves the variable the same way Next.js does (@next/env,
 * same precedence: process.env > .env.production.local > .env.local >
 * .env.production > .env) and refuses to build if the result would ship a
 * broken/localhost API URL. Local static-export test builds must be explicit:
 *   ALLOW_LOCAL_API=1 npm run build
 */
import pkg from "@next/env";
const { loadEnvConfig } = pkg;

const cwd = process.cwd();
const { combinedEnv } = loadEnvConfig(cwd);
const url = combinedEnv.NEXT_PUBLIC_API_URL ?? "";

const allowLocal = process.env.ALLOW_LOCAL_API === "1";

function fail(msg) {
  console.error(`\n[x] BUILD BLOCKED: ${msg}\n`);
  console.error("    Production deploy (correct URL, always passes):");
  console.error("      npm run deploy:web");
  console.error("    Local-only static test build (intentional localhost):");
  console.error("      ALLOW_LOCAL_API=1 npm run build\n");
  process.exit(1);
}

if (allowLocal) {
  console.warn(
    `\n[!] ALLOW_LOCAL_API=1 — building with NEXT_PUBLIC_API_URL="${url || "(empty)"}".\n` +
      "    NEVER deploy this build to Cloudflare Pages.\n"
  );
  process.exit(0);
}

if (!url) {
  fail(
    'NEXT_PUBLIC_API_URL is not set — the built site would silently degrade to localStorage-only mode (no API fetches at all).'
  );
}

if (/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
  fail(
    `NEXT_PUBLIC_API_URL="${url}" is a local dev address (likely from .env.local, ` +
      "which overrides .env.production). Shipping it would break every visitor's API fetches."
  );
}

if (!url.startsWith("https://")) {
  fail(
    `NEXT_PUBLIC_API_URL="${url}" is not https:// — browsers on the https pages.dev site ` +
      "would block it as mixed content."
  );
}

console.log(`[ok] NEXT_PUBLIC_API_URL=${url}`);
