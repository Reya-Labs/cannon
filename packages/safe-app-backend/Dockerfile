FROM node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS node-base

FROM node-base AS pnpm-base

ARG PNPM_VERSION=10.11.0
ARG PNPM_SHA512=6540583f41cc5f628eb3d9773ecee802f4f9ef9923cc45b69890fb47991d4b092964694ec3a4f738a420c918a333062c8b925d312f42e4f0c263eb603551f977
RUN npm pack --ignore-scripts "pnpm@${PNPM_VERSION}" --pack-destination /tmp \
    && echo "${PNPM_SHA512}  /tmp/pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
    && npm install --global --ignore-scripts "/tmp/pnpm-${PNPM_VERSION}.tgz" \
    && rm "/tmp/pnpm-${PNPM_VERSION}.tgz"

FROM pnpm-base AS build

WORKDIR /usr/app

COPY ./package.json ./pnpm-lock.yaml ./tsconfig.json ./
RUN pnpm i --frozen-lockfile --ignore-scripts
COPY ./src ./src
RUN pnpm run build

FROM pnpm-base AS production-dependencies

WORKDIR /usr/app

COPY ./package.json ./pnpm-lock.yaml ./
RUN pnpm i --prod --frozen-lockfile --ignore-scripts

FROM node-base

WORKDIR /usr/app

ARG VERSION=unknown
ARG BUILD_DATE=unknown
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/Reya-Labs/cannon" \
      org.opencontainers.image.description="Hardened signature staging backend for Reya Safe transactions" \
      org.opencontainers.image.licenses="GPL-3.0" \
      org.opencontainers.image.title="Cannon Safe App Backend" \
      org.opencontainers.image.vendor="usecannon" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.documentation="https://github.com/Reya-Labs/cannon/tree/dev/packages/safe-app-backend"


ENV NODE_ENV=production
ENV PORT=8080
ENV BUILD_REVISION=${BUILD_REVISION}

EXPOSE ${PORT}

RUN rm -rf \
      /opt/yarn-v1.22.22 \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

COPY --from=production-dependencies /usr/app/node_modules ./node_modules
COPY --from=build /usr/app/dist ./dist

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/readyz" || exit 1

CMD ["node", "dist/server.js"]
