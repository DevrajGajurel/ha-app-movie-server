const { createClient } = require("redis");

// FlareSolverr solves a real anti-bot challenge (Cloudflare Turnstile, the
// "vDDoS" JS challenge, etc.) by driving an actual browser - several
// seconds to tens of seconds per page (see v1.7.29/v1.7.30). The clearance
// it earns doesn't need to be re-solved on every single request to the same
// site: Cloudflare issues a `cf_clearance` cookie that a plain fetch
// carrying that same cookie (plus the same User-Agent FlareSolverr's
// browser used - Cloudflare's check is tied to that fingerprint, not just
// the cookie value) sails through un-challenged with. Confirmed live on a
// real site (filesdl.top): the issued cookie's own `expiry` was a full year
// out, not the ~30 minute default - site owners configure this per zone, so
// trusting whatever expiry Cloudflare itself hands back (rather than
// assuming a short fixed TTL) is what makes this worth doing at all.
//
// Reads/writes stay synchronous against an in-memory Map, keyed by the
// cookie's own `domain` (a leading "." wildcards every subdomain under it,
// e.g. ".filesdl.top" covers both new1.filesdl.in-style hops after they
// land there and new8.filesdl.top directly) - every existing call site in
// main.js calls these without awaiting, so that can't change. Redis is a
// write-through persistence layer underneath it: every store/invalidate
// mirrors to Redis (fire-and-forget, best-effort), and initClearanceCache
// loads whatever survived a prior process's lifetime back into the Map
// before the server starts taking requests - without that, a routine
// restart (deploy, add-on reboot) would throw away a cookie that's still
// perfectly good, forcing the next request - and the clearance-warming
// sweep in main.js - to pay a fresh FlareSolverr solve for nothing.
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // stop trusting a clearance 5 min before Cloudflare would
const DEFAULT_TTL_MS = 30 * 60 * 1000; // Cloudflare's own documented default when no expiry is given
const REDIS_PREFIX = "movieserver:v1:cfclearance";

const store = new Map();
let client = null;

function domainKey(domain) {
  return String(domain || "").toLowerCase().replace(/^\./, "");
}

function redisKeyFor(domain) {
  return `${REDIS_PREFIX}:${domain}`;
}

function isRedisReady() {
  return Boolean(client?.isReady);
}

async function initClearanceCache(redisUrl) {
  if (!redisUrl) return false;
  client = createClient({ url: redisUrl });
  client.on("error", (err) => console.warn("[cf-clearance]", err.message));
  await client.connect();

  try {
    const keys = await client.keys(`${REDIS_PREFIX}:*`);
    for (const key of keys) {
      const raw = await client.get(key);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (!entry?.expiresAt || entry.expiresAt <= Date.now()) continue;
      store.set(key.slice(REDIS_PREFIX.length + 1), entry);
    }
    if (store.size) {
      console.log(`[cf-clearance] restored ${store.size} cached clearance(s) from redis`);
    }
  } catch (err) {
    console.warn("[cf-clearance] failed to restore from redis:", err.message);
  }

  return true;
}

// Fire-and-forget: a failed persist just means a restart won't have this
// one entry to restore, not that the in-memory cache (already updated by
// the caller) stops working for the rest of this process's life.
function persistToRedis(domain, entry) {
  if (!isRedisReady()) return;
  const ttlSeconds = Math.ceil((entry.expiresAt - Date.now()) / 1000);
  if (ttlSeconds <= 0) return;
  client
    .set(redisKeyFor(domain), JSON.stringify(entry), { EX: ttlSeconds })
    .catch((err) => console.warn(`[cf-clearance] failed to persist ${domain} to redis:`, err.message));
}

function removeFromRedis(domain) {
  if (!isRedisReady()) return;
  client.del(redisKeyFor(domain)).catch(() => {});
}

// cookies: FlareSolverr's solution.cookies array. Stores every cookie it was
// handed, not just cf_clearance - some fronts layer their own additional
// cookie on top (confirmed: filesdl.top's own "vDDoS-FX"), and there's no
// reliable way to know from here which of them the site actually checks.
function storeClearance(cookies, userAgent) {
  if (!Array.isArray(cookies) || !cookies.length || !userAgent) return;
  const clearance = cookies.find((c) => c.name === "cf_clearance" && c.domain && c.value);
  if (!clearance) return;

  const cookieHeader = cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const expiresAt = clearance.expiry
    ? clearance.expiry * 1000 - SAFETY_MARGIN_MS
    : Date.now() + DEFAULT_TTL_MS - SAFETY_MARGIN_MS;

  if (expiresAt <= Date.now()) return;

  const key = domainKey(clearance.domain);
  const entry = { cookieHeader, userAgent, expiresAt };
  store.set(key, entry);
  console.log(
    `[cf-clearance] cached for ${key} until ${new Date(expiresAt).toISOString()}`
  );
  persistToRedis(key, entry);
}

function getClearance(hostname) {
  const host = domainKey(hostname);
  for (const [domain, entry] of store) {
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (entry.expiresAt > Date.now()) return entry;
    store.delete(domain);
    removeFromRedis(domain);
    return null;
  }
  return null;
}

// A clearance that turned out to no longer work (site re-issued a fresh
// challenge despite our cookie) - drop it immediately rather than waiting
// for its claimed expiry, so the next request doesn't retry the same dead
// cookie.
function invalidateClearance(hostname) {
  const host = domainKey(hostname);
  for (const domain of store.keys()) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      store.delete(domain);
      removeFromRedis(domain);
    }
  }
}

module.exports = { initClearanceCache, storeClearance, getClearance, invalidateClearance };
