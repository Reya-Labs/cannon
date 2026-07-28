FROM node:22.11.0-alpine@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e AS build

WORKDIR /usr/app

RUN npm install --global pnpm@10.11.0
COPY ./pnpm-workspace.yaml ./package.json ./pnpm-lock.yaml ./
COPY ./packages/builder/package.json ./packages/builder/tsconfig.json ./packages/builder/tsconfig.build.json ./packages/builder/
COPY ./packages/indexer/package.json ./packages/indexer/tsconfig.build.json ./packages/indexer/

RUN pnpm i --frozen-lockfile --no-optional -r --filter @usecannon/builder --filter @usecannon/indexer
COPY ./packages/builder/ ./packages/builder/
COPY ./packages/indexer/ ./packages/indexer/

RUN pnpm run -r --filter @usecannon/builder build:node
RUN pnpm --filter @usecannon/indexer exec tsc -p tsconfig.build.json --noEmit
RUN pnpm --filter @usecannon/indexer exec ncc build src/index.ts --transpile-only -o dist/registry \
    && node ./packages/indexer/scripts/assert-registry-bundle.cjs ./packages/indexer/dist/registry
RUN pnpm --filter @usecannon/indexer exec ncc build src/worker.ts --transpile-only -o dist/artifact-worker
RUN pnpm --filter @usecannon/indexer exec ncc build src/4byte-directory.ts --transpile-only -o dist/4byte-directory

FROM node:22.11.0-alpine@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e

WORKDIR /usr/app

ARG VERSION=unknown
ARG BUILD_DATE=1970-01-01T00:00:00Z
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/usecannon/cannon" \
      org.opencontainers.image.description="Injects Cannon data from raw data sources into Redis" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="Cannon Indexer" \
      org.opencontainers.image.vendor="usecannon" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.documentation="https://github.com/usecannon/cannon/tree/main/packages/indexer"

ENV NODE_ENV=production
ENV PORT=8080
ENV BUILD_REVISION=${BUILD_REVISION}

COPY --from=build /usr/app/packages/indexer/dist ./dist

USER node

CMD ["node", "dist/registry/index.js"]
