ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM ${BUILD_FROM}
ARG APP_GIT_URL=https://github.com/DevrajGajurel/ha-app-movie-server.git
ARG APP_GIT_REF=main
ARG APP_BUILD_VERSION=1.6.25
ARG CF_CLEARANCE_GIT_URL=https://github.com/ZFC-Digital/cf-clearance-scraper.git
ARG CF_CLEARANCE_GIT_REF=main

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIDSRC_PYTHON=python3 \
    HOME_ASSISTANT_ADDON=true \
    CF_CLEARANCE_URL=http://127.0.0.1:3000 \
    PORT=3000 \
    browserLimit=5 \
    timeOut=60000 \
    # Use the system Google Chrome; do not let Puppeteer download a second browser.
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime packages only. git/gnupg/python3-dev are installed briefly below and purged.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        ffmpeg \
        python3 \
        python3-pip \
        xvfb \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        xdg-utils \
        aria2 \
    && rm -rf /var/lib/apt/lists/*

# Node + Chrome (build-only helpers purged at the end of this layer).
RUN apt-get update && apt-get install -y --no-install-recommends gnupg wget \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && apt-get purge -y --auto-remove gnupg wget \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && echo "Installing movie-server ${APP_BUILD_VERSION}" \
 && git clone --depth 1 --branch "${APP_GIT_REF}" "${APP_GIT_URL}" /tmp/repo \
 && cp -r /tmp/repo/src/movie_server/. /app/ \
 && mkdir -p /vidsrc \
 && cp -r /tmp/repo/src/vidsrc/. /vidsrc/ \
 && rm -rf /vidsrc/downloaded_files /vidsrc/.git /tmp/repo \
 && npm install --omit=dev \
 && pip3 install --break-system-packages --no-cache-dir -r /vidsrc/requirements.txt \
 && apt-get purge -y --auto-remove git \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache /root/.npm /tmp/*

# Bundle cf-clearance-scraper. Strip test-only deps (jest/supertest are wrongly
# listed as production dependencies upstream) and drop VCS/tests to save space.
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && git clone --depth 1 --branch "${CF_CLEARANCE_GIT_REF}" "${CF_CLEARANCE_GIT_URL}" /opt/cf-clearance \
 && cd /opt/cf-clearance \
 && npm install --omit=dev \
 && npm uninstall --no-save jest supertest \
 && rm -rf tests .git .github .dockerignore Dockerfile README.md LICENSE.md \
        node_modules/@babel node_modules/@jest node_modules/jest* \
        node_modules/caniuse-lite node_modules/@types \
 && npm cache clean --force \
 && apt-get purge -y --auto-remove git \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache /root/.npm /tmp/*

# Overlay our Chrome/Xvfb-aware createBrowser.js (rootfs) after the upstream clone.
COPY rootfs /
RUN chmod a+x /etc/services.d/xvfb/run \
 && chmod a+x /etc/services.d/cf-clearance/run \
 && chmod a+x /etc/services.d/movie-server/run \
 && chmod a+x /etc/cont-init.d/* 2>/dev/null || true \
 && test -f /opt/cf-clearance/src/module/createBrowser.js
