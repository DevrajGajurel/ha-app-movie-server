async function resolveRedirectUrl(inputUrl) {
  const start = new URL(inputUrl).href;

  let res;
  try {
    res = await fetch(start, { method: "HEAD", redirect: "follow" });
  } catch {
    res = null;
  }

  if (!res || res.status === 405 || res.status === 501) {
    res = await fetch(start, { method: "GET", redirect: "follow" });
  }

  return res.url || start;
}

module.exports = { resolveRedirectUrl };
