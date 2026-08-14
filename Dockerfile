FROM node:20-bookworm

# Local compose image — same runtime as the Home Assistant add-on
# (movie-server/Dockerfile): Node, ffmpeg, aria2. No Chrome, Xvfb, Python,
# vidsrc, or cf-clearance sidecar. Source is copied from this repo instead
# of cloned from GitHub so `docker compose up --build` uses the working tree.
ENV DEBIAN_FRONTEND=noninteractive \
    PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        ffmpeg \
        aria2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY src/movie_server/package.json src/movie_server/package-lock.json* ./
RUN npm install --omit=dev

COPY src/movie_server/ ./

EXPOSE 3001

CMD ["npm", "start"]
