ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM}
ARG APP_GIT_URL=https://github.com/DevrajGajurel/ha-app-movie-server.git
ARG APP_GIT_REF=main
ARG APP_BUILD_VERSION=1.4.2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm git ffmpeg

WORKDIR /app
RUN echo "Installing movie-server ${APP_BUILD_VERSION}" \
 && git clone --depth 1 --branch "${APP_GIT_REF}" "${APP_GIT_URL}" /tmp/repo \
 && cp -r /tmp/repo/src/movie_server/. /app/ \
 && npm install --omit=dev \
 && rm -rf /tmp/repo

COPY rootfs /
RUN chmod a+x /etc/services.d/movie-server/run
