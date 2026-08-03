FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY src/movie_server/package.json src/movie_server/package-lock.json* ./
RUN npm install --omit=dev

COPY src/movie_server/main.js src/movie_server/tmdb.js src/movie_server/tmdbCache.js src/movie_server/quality.js src/movie_server/fileDownloads.js src/movie_server/emby.js src/movie_server/urlUtils.js src/movie_server/movieCache.js src/movie_server/mediaProbeCache.js src/movie_server/trailer.js src/movie_server/cinebyProxy.js ./
COPY src/movie_server/public ./public

ENV PORT=3001
EXPOSE 3001

CMD ["npm", "start"]
