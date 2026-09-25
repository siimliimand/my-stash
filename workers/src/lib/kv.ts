/** Thin, typed KV helpers. Every helper swallows transport errors and
 * reports failure in its return value — KV outages must never take a request
 * or the generation pipeline down (plan §13). */

export type Validator<T> = (value: unknown) => T | null;

/** KV value is eventually consistent (up to ~60s stale) — never use it as the
 * authoritative idempotency guard; that is D1 `generation_log`. */

/** Get + JSON-parse + validate. Returns null on miss, corruption, or error. */
export async function getJson<T>(
  kv: KVNamespace,
  key: string,
  validator: Validator<T>,
): Promise<T | null> {
  try {
    const parsed: unknown = await kv.get(key, 'json');
    if (parsed === null || parsed === undefined) return null;
    const validated = validator(parsed);
    return validated;
  } catch {
    return null;
  }
}

/** JSON-stringify + put. `ttlSeconds` is clamped to KV's 60s minimum.
 * Returns true when the write succeeded. */
export async function putJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<boolean> {
  try {
    if (ttlSeconds !== undefined) {
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) });
    } else {
      await kv.put(key, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

/** Delete a single key. Idempotent; returns true when the delete succeeded. */
export async function deleteKey(kv: KVNamespace, key: string): Promise<boolean> {
  try {
    await kv.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Delete every key under `prefix` (follows list cursors, bounded pages).
 * Returns the number of keys deleted. */
export async function deletePrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined = undefined;
  try {
    // Safety bound: the cache namespace holds a handful of keys; 50 pages of
    // 100 keys each is far more than we will ever need.
    for (let page = 0; page < 50; page++) {
      const result: KVNamespaceListResult<unknown, string> = await kv.list({ prefix, limit: 100, cursor });
      for (const key of result.keys) {
        try {
          await kv.delete(key.name);
          deleted++;
        } catch {
          // leave the key; it expires via TTL anyway
        }
      }
      if (result.list_complete) break;
      cursor = result.cursor;
    }
  } catch {
    // listing failed: remaining keys expire via TTL
  }
  return deleted;
}
