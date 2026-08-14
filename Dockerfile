FROM node:20-bookworm

# Same runtime as the Home Assistant add-on (ffmpeg, aria2; no Chrome/Python).
# App source lives in movie-server/app so HA and local compose share one tree.
ENV DEBIAN_FRONTEND=noninteractive \
    PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        aria2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY movie-server/app/package.json movie-server/app/package-lock.json* ./
RUN npm install --omit=dev

COPY movie-server/app/ ./

EXPOSE 3001

CMD ["npm", "start"]
