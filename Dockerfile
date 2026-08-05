FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIDSRC_PYTHON=python3

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ffmpeg \
        xvfb \
        wget \
        gnupg \
        ca-certificates \
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
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src/movie_server/package.json src/movie_server/package-lock.json* ./
RUN npm install --omit=dev

COPY src/movie_server/main.js \
     src/movie_server/tmdb.js \
     src/movie_server/tmdbCache.js \
     src/movie_server/quality.js \
     src/movie_server/fileDownloads.js \
     src/movie_server/emby.js \
     src/movie_server/urlUtils.js \
     src/movie_server/movieCache.js \
     src/movie_server/mediaProbeCache.js \
     src/movie_server/trailer.js \
     src/movie_server/cinebyProxy.js \
     src/movie_server/hlsProxy.js \
     src/movie_server/streamCatalog.js \
     src/movie_server/streamResolve.js \
     ./
COPY src/movie_server/public ./public

COPY src/vidsrc /vidsrc
RUN pip3 install --break-system-packages --no-cache-dir -r /vidsrc/requirements.txt

ENV PORT=3001
EXPOSE 3001

# Chrome needs shared memory; compose should set shm_size when possible.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 & sleep 1 && npm start"]
