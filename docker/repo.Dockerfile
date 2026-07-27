FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS node-runtime

FROM node-runtime AS build

WORKDIR /usr/app

ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}

ARG PNPM_VERSION=10.11.0
ARG PNPM_SHA512=6540583f41cc5f628eb3d9773ecee802f4f9ef9923cc45b69890fb47991d4b092964694ec3a4f738a420c918a333062c8b925d312f42e4f0c263eb603551f977
ARG NCC_VERSION=0.44.1
ARG NCC_SHA512=7148c81393f6618d67f8ab7dac521accc3291a83e7d4589cd38ace99390494c9220cfe68b3319f111329a36b2156414a0cbeeb569a5d336a6a24a0b9f6c85059
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    && corepack prepare "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}" --activate \
    && corepack enable pnpm \
    && wget -q -O /tmp/ncc.tgz "https://registry.npmjs.org/@vercel/ncc/-/ncc-${NCC_VERSION}.tgz" \
    && echo "${NCC_SHA512}  /tmp/ncc.tgz" | sha512sum -c - \
    && pnpm add --global --ignore-scripts --offline /tmp/ncc.tgz \
    && rm /tmp/ncc.tgz
COPY ./pnpm-workspace.yaml ./package.json ./pnpm-lock.yaml ./
COPY ./packages/artifact-codec/package.json ./packages/artifact-codec/tsconfig.json ./packages/artifact-codec/rollup.config.mjs ./packages/artifact-codec/
COPY ./packages/repo/package.json ./packages/repo/tsconfig.json ./packages/repo/

RUN pnpm i --frozen-lockfile --ignore-scripts --no-optional -r --filter @usecannon/artifact-codec --filter @usecannon/repo
COPY ./packages/artifact-codec/ ./packages/artifact-codec/
COPY ./packages/repo/ ./packages/repo/

RUN pnpm run -r --filter @usecannon/artifact-codec build
RUN ncc build ./packages/repo/src/index.ts -o ./packages/repo/dist
COPY ./.github/scripts/generate-bundle-input-sbom.mjs /usr/local/lib/generate-bundle-input-sbom.mjs
RUN pnpm --filter @usecannon/repo list --prod --no-optional --depth Infinity --json \
      > /tmp/bundle-input-dependencies.json \
    && node /usr/local/lib/generate-bundle-input-sbom.mjs \
      /usr/app \
      /tmp/bundle-input-dependencies.json \
      /usr/app/bundle-input-dependencies.cdx.json \
      @usecannon/repo \
      "$(node -p "require('./packages/repo/package.json').version")"

FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

WORKDIR /usr/app

# Keep APK metadata intact while installing only Node's pinned runtime libraries.
# npm, Corepack and Yarn never enter the final image.
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

LABEL org.opencontainers.image.source="https://github.com/Reya-Labs/cannon" \
      org.opencontainers.image.description="Cannon IPFS Repo Service with Kubo interface for fetching and pinning cannon packages" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="Cannon IPFS Repo Service" \
      org.opencontainers.image.vendor="Reya Labs" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24.1" \
      org.opencontainers.image.base.digest="sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b" \
      io.reya.cannon.runtime.node.name="docker.io/library/node:22.23.1-alpine3.24" \
      io.reya.cannon.runtime.node.digest="sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2" \
      org.opencontainers.image.documentation="https://github.com/Reya-Labs/cannon/tree/dev/packages/repo"

ENV NODE_ENV=production
ENV PORT=8080
ENV BUILD_REVISION=${BUILD_REVISION}

COPY --from=build /usr/app/packages/repo/dist .
COPY --from=build /usr/app/bundle-input-dependencies.cdx.json ./bundle-input-dependencies.cdx.json

USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "index.js"]
