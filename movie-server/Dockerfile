ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM ${BUILD_FROM}
ARG APP_GIT_URL=https://github.com/DevrajGajurel/ha-app-movie-server.git
ARG APP_GIT_REF=main
ARG APP_BUILD_VERSION=1.7.1

ENV DEBIAN_FRONTEND=noninteractive \
    HOME_ASSISTANT_ADDON=true \
    PORT=3000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime packages only. git/gnupg are installed briefly below and purged.
# No Chrome/Xvfb/Python - the Cloudflare-bypass (cf-clearance) and vidsrc
# Streams scraper that needed them were removed; downloads that would have
# hit a real Cloudflare Turnstile challenge just fail now (plain fetch),
# rather than paying for a bundled browser on every image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        ffmpeg \
        aria2 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && echo "Installing movie-server ${APP_BUILD_VERSION}" \
 && git clone --depth 1 --branch "${APP_GIT_REF}" "${APP_GIT_URL}" /tmp/repo \
 && cp -r /tmp/repo/src/movie_server/. /app/ \
 && rm -rf /tmp/repo \
 && npm install --omit=dev \
 && apt-get purge -y --auto-remove git \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.cache /root/.npm /tmp/*

COPY rootfs /
RUN chmod a+x /etc/services.d/movie-server/run \
 && chmod a+x /etc/cont-init.d/* 2>/dev/null || true
