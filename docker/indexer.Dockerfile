FROM node:22.11.0-alpine@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e AS build

WORKDIR /usr/app

RUN npm install --global pnpm@10.11.0 @vercel/ncc@0.44.1
COPY ./pnpm-workspace.yaml ./package.json ./pnpm-lock.yaml ./
COPY ./packages/builder/package.json ./packages/builder/tsconfig.json ./packages/builder/tsconfig.build.json ./packages/builder/
COPY ./packages/repo/package.json ./packages/repo/tsconfig.json ./packages/repo/
COPY ./packages/indexer/package.json ./packages/indexer/tsconfig.build.json ./packages/indexer/

RUN pnpm i --frozen-lockfile --no-optional -r --filter @usecannon/builder --filter @usecannon/repo --filter @usecannon/indexer
COPY ./packages/builder/ ./packages/builder/
COPY ./packages/repo/ ./packages/repo/
COPY ./packages/indexer/ ./packages/indexer/

RUN pnpm run -r --filter @usecannon/builder build:node
RUN pnpm run -r --filter @usecannon/repo build
RUN ncc build ./packages/indexer/src/index.ts -o ./packages/indexer/dist/registry
RUN ncc build ./packages/indexer/src/4byte-directory.ts -o ./packages/indexer/dist/4byte-directory

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
