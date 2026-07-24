FROM node:22.11.0-alpine@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e AS build

WORKDIR /usr/app

RUN npm install --global pnpm@10.11.0 @vercel/ncc@0.44.1
COPY ./pnpm-workspace.yaml ./package.json ./pnpm-lock.yaml ./
COPY ./packages/builder/package.json ./packages/builder/tsconfig.json ./packages/builder/tsconfig.build.json ./packages/builder/
COPY ./packages/repo/package.json ./packages/repo/tsconfig.json ./packages/repo/

RUN pnpm i --frozen-lockfile --no-optional -r --filter @usecannon/builder --filter @usecannon/repo
COPY ./packages/builder/ ./packages/builder/
COPY ./packages/repo/ ./packages/repo/

RUN pnpm run -r --filter @usecannon/builder build:node
RUN ncc build ./packages/repo/src/index.ts -o ./packages/repo/dist

RUN echo $(node -p "require('./packages/repo/package.json').version") > /version.txt

FROM node:22.11.0-alpine@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e

WORKDIR /usr/app

COPY --from=build /version.txt /version.txt
ARG VERSION=$(cat /version.txt)
ARG BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.source="https://github.com/usecannon/cannon" \
      org.opencontainers.image.description="Cannon IPFS Repo Service with Kubo interface for fetching and pinning cannon packages" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="Cannon IPFS Repo Service" \
      org.opencontainers.image.vendor="usecannon" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.documentation="https://github.com/usecannon/cannon/tree/main/packages/repo"

ENV NODE_ENV=production
ENV PORT=8080
ENV BUILD_REVISION=${BUILD_REVISION}

COPY --from=build /usr/app/packages/repo/dist .

CMD ["node", "index.js"]
