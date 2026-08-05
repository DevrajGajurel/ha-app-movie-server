ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM ${BUILD_FROM}
ARG APP_GIT_URL=https://github.com/DevrajGajurel/ha-app-movie-server.git
ARG APP_GIT_REF=main
ARG APP_BUILD_VERSION=1.6.17

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIDSRC_PYTHON=python3 \
    HOME_ASSISTANT_ADDON=true

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        git \
        ffmpeg \
        python3 \
        python3-pip \
        xvfb \
        wget \
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
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN echo "Installing movie-server ${APP_BUILD_VERSION}" \
 && git clone --depth 1 --branch "${APP_GIT_REF}" "${APP_GIT_URL}" /tmp/repo \
 && cp -r /tmp/repo/src/movie_server/. /app/ \
 && cp -r /tmp/repo/src/vidsrc /vidsrc \
 && npm install --omit=dev \
 && pip3 install --break-system-packages --no-cache-dir -r /vidsrc/requirements.txt \
 && rm -rf /tmp/repo

COPY rootfs /
RUN chmod a+x /etc/services.d/movie-server/run \
 && chmod a+x /etc/cont-init.d/* 2>/dev/null || true
