#!/usr/bin/env node
/**
 * Post-build safety net: scans the static export in out/ for localhost API
 * URLs baked into the client bundles.
 *
 * WHY: this is the last line of defense before `wrangler pages deploy`. The
 * prebuild guard (check-build-env.mjs) validates the resolved env value, but
 * env handling can change between Next.js versions — this verifies the BUILT
 * ARTIFACT itself, so a production deploy can never ship the 2026-09-29
 * incident (bundle with http://localhost:8787 inlined) again.
 *
 * Also asserts the expected production URL IS present, catching the opposite
 * failure mode (env not inlined at all).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "out");
// Expected production URL: CLI arg (used by the deploy:web script) or env.
const EXPECTED_URL = process.argv[2] ?? process.env.NEXT_PUBLIC_API_URL ?? "";
const allowLocal = process.env.ALLOW_LOCAL_API === "1";

const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s"'`)]*)?/g;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else if (/\.(js|mjs|html|css|txt|json)$/.test(e.name)) files.push(p);
  }
  return files;
}

const files = await walk(OUT_DIR);
const leaks = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(LOCALHOST_RE)) {
    leaks.push({ file: file.replace(OUT_DIR + "/", ""), url: match[0] });
  }
}

if (leaks.length > 0 && !allowLocal) {
  console.error("\n[x] BUILD VERIFICATION FAILED: localhost URL(s) found in out/ — DO NOT DEPLOY:\n");
  for (const leak of leaks.slice(0, 20)) {
    console.error(`    ${leak.file}  ->  ${leak.url}`);
  }
  if (leaks.length > 20) console.error(`    ... and ${leaks.length - 20} more`);
  console.error("\n    This build would break API fetches for every visitor.");
  console.error("    Fix: build via `npm run deploy:web` (sets the production URL)\n");
  process.exit(1);
}

if (leaks.length > 0 && allowLocal) {
  console.warn(
    `[!] ALLOW_LOCAL_API=1 — tolerating ${leaks.length} localhost URL(s) in out/. ` +
      "This build is for local serving only; NEVER deploy it.\n"
  );
}

if (!allowLocal && EXPECTED_URL) {
  // The production URL must actually be IN the bundle — a silent env dropout
  // is exactly as broken as a wrong URL (site degrades to localStorage-only).
  let found = false;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (content.includes(EXPECTED_URL)) {
      found = true;
      break;
    }
  }
  if (!found) {
    console.error(
      `\n[x] BUILD VERIFICATION FAILED: ${EXPECTED_URL} was NOT inlined into out/.\n` +
        "    The site would ship without a working API base URL.\n"
    );
    process.exit(1);
  }
}

console.log(`[ok] out/ verified: no localhost leaks${EXPECTED_URL ? `, ${EXPECTED_URL} inlined` : " (no expected URL given — inlining check skipped)"} (${files.length} files scanned)`);
