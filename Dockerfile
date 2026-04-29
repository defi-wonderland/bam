# syntax=docker/dockerfile:1.7
#
# Fat container: Postgres + bam-poster + bam-reader in one image.
#
# Stages:
#   1. builder  — node:20-bookworm-slim with build tooling for c-kzg's
#                  native module. Installs the workspace and builds the
#                  four packages we ship.
#   2. runtime  — postgres:16-bookworm with Node.js 20 layered on top.
#                  Reuses the upstream postgres docker-entrypoint.sh for
#                  first-boot initdb; our supervisor wraps it.

# ---- Builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       python3 \
       ca-certificates \
       curl \
       git \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm \
      --filter bam-sdk \
      --filter bam-store \
      --filter @bam/poster \
      --filter bam-reader \
      run build

# ---- Runtime ---------------------------------------------------------------
FROM postgres:16-bookworm AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       ca-certificates \
       gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Postgres bootstrap (used by upstream docker-entrypoint.sh on first boot)
ENV POSTGRES_DB=bam \
    POSTGRES_USER=postgres \
    POSTGRES_PASSWORD=postgres \
    PGDATA=/var/lib/postgresql/data

# Service defaults — override at deploy time as needed.
ENV POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bam \
    POSTER_HOST=0.0.0.0 \
    POSTER_PORT=8787 \
    READER_HTTP_BIND=0.0.0.0 \
    READER_HTTP_PORT=8788 \
    READER_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/bam

WORKDIR /app
COPY --from=builder /app /app

COPY docker/entrypoint.sh /usr/local/bin/bam-entrypoint.sh
RUN chmod +x /usr/local/bin/bam-entrypoint.sh

EXPOSE 5432 8787 8788

ENTRYPOINT ["/usr/local/bin/bam-entrypoint.sh"]
