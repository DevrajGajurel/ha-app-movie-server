FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY src/movie_server/package.json src/movie_server/package-lock.json* ./
RUN npm install --omit=dev

COPY src/movie_server/main.js src/movie_server/tmdb.js src/movie_server/quality.js src/movie_server/fileDownloads.js src/movie_server/emby.js src/movie_server/urlUtils.js ./
COPY src/movie_server/public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
