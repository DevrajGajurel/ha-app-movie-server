function getEmbyConfig() {
  const baseUrl = String(process.env.EMBY_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.EMBY_API_KEY || "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

function isEmbyConfigured() {
  return Boolean(getEmbyConfig());
}

function toEmbyPath(filePath) {
  const downloadDir = String(process.env.DOWNLOAD_DIR || "").trim().replace(/\/+$/, "");
  const embyPrefix = String(process.env.EMBY_PATH_PREFIX || "").trim().replace(/\/+$/, "");
  if (!embyPrefix || !downloadDir) return filePath;

  const normalized = filePath.replace(/\\/g, "/");
  const base = downloadDir.replace(/\\/g, "/");
  if (normalized.startsWith(`${base}/`)) {
    return `${embyPrefix}${normalized.slice(base.length)}`;
  }
  return filePath;
}

async function embyPost(apiPath, body) {
  const config = getEmbyConfig();
  if (!config) {
    throw new Error("Emby is not configured. Set EMBY_URL and EMBY_API_KEY.");
  }

  const candidates = [
    `${config.baseUrl}/emby${apiPath}`,
    `${config.baseUrl}${apiPath}`,
  ];

  let lastError = null;
  for (const candidate of candidates) {
    const url = new URL(candidate);
    url.searchParams.set("api_key", config.apiKey);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : "",
      });

      if (response.ok || response.status === 204) {
        return { endpoint: url.pathname };
      }

      if (response.status === 404) continue;

      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Emby returned ${response.status}${detail ? `: ${detail}` : ""}`);
    } catch (err) {
      lastError = err;
      if (err.cause?.code === "ENOTFOUND" || err.cause?.code === "ECONNREFUSED") {
        throw err;
      }
    }
  }

  throw lastError || new Error("Emby request failed");
}

async function refreshLibrary() {
  await embyPost("/Library/Refresh");
  console.log("[emby] full library refresh started");
  return { mode: "full", message: "Emby library refresh started" };
}

async function notifyMediaUpdated(filePath, updateType = "Created") {
  const embyPath = toEmbyPath(filePath);
  await embyPost("/Library/Media/Updated", {
    Updates: [{ Path: embyPath, UpdateType: updateType }],
  });
  console.log(`[emby] notified media update: ${embyPath}`);
  return { mode: "path", path: embyPath, message: "Emby notified of new media" };
}

async function refreshAfterDownload(filePath) {
  if (!isEmbyConfigured()) return null;

  try {
    return await notifyMediaUpdated(filePath, "Created");
  } catch (err) {
    console.warn(`[emby] path notify failed (${err.message}), falling back to full refresh`);
    return refreshLibrary();
  }
}

module.exports = {
  isEmbyConfigured,
  refreshLibrary,
  notifyMediaUpdated,
  refreshAfterDownload,
};
