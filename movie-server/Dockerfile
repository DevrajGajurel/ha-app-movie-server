ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM ${BUILD_FROM}

ENV DEBIAN_FRONTEND=noninteractive \
    HOME_ASSISTANT_ADDON=true \
    PORT=3000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# One apt pass: Debian bookworm Node 18 (engines >=18), ffmpeg, aria2.
# No NodeSource, no git clone of the GitHub repo — both were the bulk of
# every add-on rebuild. App files live in this add-on folder (`app/`) so
# Supervisor can COPY them from build context.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        aria2 \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev \
    && rm -rf /root/.npm /tmp/*

COPY app/ ./
COPY rootfs /
RUN chmod a+x /etc/services.d/movie-server/run \
 && chmod a+x /etc/cont-init.d/* 2>/dev/null || true
