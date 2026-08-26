ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM ${BUILD_FROM}

ENV DEBIAN_FRONTEND=noninteractive \
    HOME_ASSISTANT_ADDON=true \
    PORT=3000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# One apt pass: Debian bookworm Node 18 (engines >=18), ffmpeg, aria2,
# python3/pip for yt-dlp. No NodeSource, no git clone of the GitHub repo —
# both were the bulk of every add-on rebuild. App files live in this add-on
# folder (`app/`) so Supervisor can COPY them from build context.
#
# yt-dlp (trailer.js's /api/trailer route) is installed via pip rather than
# yt-dlp's own standalone binary release - that release is only published
# for amd64, and this add-on also ships aarch64/armv7 (config.yaml's arch
# list); pip installing the pure-Python package works identically on all
# three. --break-system-packages is Debian bookworm's documented override
# for PEP 668's "externally managed environment" guard, which otherwise
# refuses any system-wide pip install - fine here since the whole container
# *is* the isolated environment already, there's no host Python to protect.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        aria2 \
        nodejs \
        npm \
        python3 \
        python3-pip \
    && pip install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev \
    && rm -rf /root/.npm /tmp/*

COPY app/ ./
COPY rootfs /
RUN chmod a+x /etc/services.d/movie-server/run \
 && chmod a+x /etc/cont-init.d/* 2>/dev/null || true
