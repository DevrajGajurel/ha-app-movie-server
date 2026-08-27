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
// In-memory only, keyed by the cookie's own `domain` (a leading "."
// wildcards every subdomain under it, e.g. ".filesdl.top" covers both
// new1.filesdl.in-style hops after they land there and new8.filesdl.top
// directly) - a process restart just means the next request to that site
// re-solves once via FlareSolverr and repopulates this, the same cost
// every request paid before this cache existed at all.
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // stop trusting a clearance 5 min before Cloudflare would
const DEFAULT_TTL_MS = 30 * 60 * 1000; // Cloudflare's own documented default when no expiry is given

const store = new Map();

function domainKey(domain) {
  return String(domain || "").toLowerCase().replace(/^\./, "");
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
  store.set(key, { cookieHeader, userAgent, expiresAt });
  console.log(
    `[cf-clearance] cached for ${key} until ${new Date(expiresAt).toISOString()}`
  );
}

function getClearance(hostname) {
  const host = domainKey(hostname);
  for (const [domain, entry] of store) {
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    if (entry.expiresAt > Date.now()) return entry;
    store.delete(domain);
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
    if (host === domain || host.endsWith(`.${domain}`)) store.delete(domain);
  }
}

module.exports = { storeClearance, getClearance, invalidateClearance };
