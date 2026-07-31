FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS node-runtime

FROM node-runtime AS pnpm-base

ARG PNPM_VERSION=10.11.0
ARG PNPM_SHA512=6540583f41cc5f628eb3d9773ecee802f4f9ef9923cc45b69890fb47991d4b092964694ec3a4f738a420c918a333062c8b925d312f42e4f0c263eb603551f977
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && corepack prepare "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}" --activate \
    && corepack enable pnpm

FROM pnpm-base AS verify

WORKDIR /usr/app

ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}

COPY ./package.json ./pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY ./src ./src
COPY ./test ./test
RUN pnpm test

FROM pnpm-base AS production-dependencies

WORKDIR /usr/app

COPY ./package.json ./pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --no-optional

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

WORKDIR /usr/app

RUN apk add --no-cache \
    libgcc=15.2.0-r5 \
    libstdc++=15.2.0-r5 \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ARG VERSION=unknown
ARG BUILD_DATE=1970-01-01T00:00:00Z
ARG BUILD_REVISION=unknown
ARG SOURCE_DATE_EPOCH=0

LABEL org.opencontainers.image.source="https://github.com/Reya-Labs/cannon" \
      org.opencontainers.image.description="Server-side Reya Cannon preview derivation for the production signer origin" \
      org.opencontainers.image.licenses="GPL-3.0" \
      org.opencontainers.image.title="Reya Cannon Preview Worker" \
      org.opencontainers.image.vendor="Reya Labs" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24.1" \
      org.opencontainers.image.base.digest="sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b" \
      io.reya.cannon.runtime.node.name="docker.io/library/node:22.23.1-alpine3.24" \
      io.reya.cannon.runtime.node.digest="sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2" \
      org.opencontainers.image.documentation="https://github.com/Reya-Labs/cannon/tree/dev/packages/preview-worker"

ENV NODE_ENV=production
ENV PORT=8080
ENV BUILD_REVISION=${BUILD_REVISION}
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}

EXPOSE ${PORT}

COPY --from=production-dependencies /usr/app/package.json ./package.json
COPY --from=production-dependencies /usr/app/node_modules ./node_modules
COPY ./src ./src

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/readyz" || exit 1

CMD ["node", "src/server.mjs"]
