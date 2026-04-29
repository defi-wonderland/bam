# syntax=docker/dockerfile:1.7

# Shared image for bam-poster and bam-reader. Each fly app overrides CMD
# to pick its service binary; the build is identical so layer caching
# wins on the second deploy of any pair.

FROM node:20-bookworm-slim AS builder

# build-essential + python3 are required to compile c-kzg's native binding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Workspace + manifests first so dep install caches independently of source.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/bam-sdk/package.json packages/bam-sdk/
COPY packages/bam-store/package.json packages/bam-store/
COPY packages/bam-poster/package.json packages/bam-poster/
COPY packages/bam-reader/package.json packages/bam-reader/
COPY packages/bam-cli/package.json packages/bam-cli/
COPY apps/bam-sdk-test/package.json apps/bam-sdk-test/
COPY apps/message-in-a-blobble/package.json apps/message-in-a-blobble/

RUN pnpm install --frozen-lockfile \
      --filter @bam/poster... --filter bam-reader...

# Source for the four packages we actually build.
COPY packages/bam-sdk packages/bam-sdk
COPY packages/bam-store packages/bam-store
COPY packages/bam-poster packages/bam-poster
COPY packages/bam-reader packages/bam-reader

# Build in dependency order.
RUN pnpm --filter bam-sdk build \
 && pnpm --filter bam-store build \
 && pnpm --filter @bam/poster build \
 && pnpm --filter bam-reader build

# Produce two self-contained, prod-only deploy trees.
RUN pnpm deploy --filter=@bam/poster --prod --legacy /out/poster \
 && pnpm deploy --filter=bam-reader  --prod --legacy /out/reader

# ---------------- runtime ----------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Trim the default node user's home noise; we only need the binary to run.
COPY --from=builder /out/poster /app/poster
COPY --from=builder /out/reader /app/reader

USER node

# Default to poster; bam-reader's fly.toml overrides this with the reader bin.
CMD ["node", "/app/poster/dist/esm/bin/bam-poster.js"]
