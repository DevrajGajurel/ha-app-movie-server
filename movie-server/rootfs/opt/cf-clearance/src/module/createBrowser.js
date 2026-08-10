const { connect } = require("puppeteer-real-browser");
const fs = require("fs");

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function createBrowser() {
  try {
    if (global.finished === true) return;

    global.browser = null;

    const chromePath = resolveChromePath();
    if (!chromePath) {
      console.error(
        "[cf-clearance] Chrome binary not found. Set CHROME_PATH or install google-chrome-stable."
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await createBrowser();
      return;
    }

    console.log(`[cf-clearance] Launching Chrome via ${chromePath} (DISPLAY=${process.env.DISPLAY || "unset"})`);

    // We already run a shared Xvfb on :99 via the add-on s6 service. Letting
    // puppeteer-real-browser spawn its own Xvfb races that display and often
    // leaves global.browser null forever ("scanner is not ready yet").
    const { browser } = await connect({
      headless: false,
      turnstile: true,
      connectOption: { defaultViewport: null },
      disableXvfb: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      customConfig: {
        chromePath,
      },
    });

    global.browser = browser;
    console.log("[cf-clearance] Browser ready");

    browser.on("disconnected", async () => {
      if (global.finished === true) return;
      console.log("[cf-clearance] Browser disconnected — relaunching");
      global.browser = null;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await createBrowser();
    });
  } catch (e) {
    console.error(`[cf-clearance] Browser launch failed: ${e.message}`);
    if (global.finished === true) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await createBrowser();
  }
}

createBrowser();
