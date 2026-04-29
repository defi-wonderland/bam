#!/usr/bin/env bash
#
# Supervisor for the BAM fat container.
#
#   1. Start the upstream postgres `docker-entrypoint.sh` in the background
#      (handles initdb + role/database creation on first boot).
#   2. Wait for postgres to accept connections via pg_isready.
#   3. Launch bam-poster and bam-reader.
#   4. If any child exits, tear the rest down and exit non-zero so the
#      orchestrator (fly machine, compose) restarts the container.

set -euo pipefail

PG_USER=${POSTGRES_USER:-postgres}
PG_DB=${POSTGRES_DB:-bam}
PG_HOST=127.0.0.1
PG_PORT=${POSTGRES_PORT:-5432}

log() {
  printf '[bam-entrypoint] %s\n' "$*"
}

# Bounded SIGTERM → SIGKILL shutdown for the listed PIDs. We're PID 1 in
# the container, and an unbounded `wait` would hang the supervisor if any
# child ignored SIGTERM (or got stuck in an uninterruptible syscall),
# which would in turn defeat the whole point of this script — exiting
# non-zero so fly/compose can restart the container.
SHUTDOWN_GRACE_S=${SHUTDOWN_GRACE_S:-10}
shutdown_children() {
  local pids=("$@")
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  local deadline=$((SECONDS + SHUTDOWN_GRACE_S))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && return 0
    sleep 0.5
  done
  log "children still alive after ${SHUTDOWN_GRACE_S}s SIGTERM grace; SIGKILL"
  for pid in "${pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

log "starting postgres (data dir: ${PGDATA:-/var/lib/postgresql/data})"
docker-entrypoint.sh postgres &
PG_PID=$!

log "waiting for postgres on ${PG_HOST}:${PG_PORT}..."
for _ in $(seq 1 120); do
  if pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    log "postgres exited before becoming ready"
    wait "$PG_PID" || true
    exit 1
  fi
  sleep 1
done

if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
  log "postgres did not become ready in time; aborting"
  shutdown_children "$PG_PID"
  exit 1
fi
log "postgres is ready"

log "starting bam-poster"
node /app/packages/bam-poster/dist/esm/bin/bam-poster.js &
POSTER_PID=$!

# Serialize bootstrap: wait for poster's HTTP /health before starting the
# reader, so the bam-store DDL (CREATE TABLE IF NOT EXISTS …) finishes
# under a single writer. Two processes racing the bootstrap on a fresh
# Postgres can collide on pg_type's unique catalog index, even with
# IF NOT EXISTS — we side-step the race by ordering startup.
POSTER_PORT_LOCAL=${POSTER_PORT:-8787}
log "waiting for bam-poster /health on 127.0.0.1:${POSTER_PORT_LOCAL}..."
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${POSTER_PORT_LOCAL}/health"; then
    break
  fi
  if ! kill -0 "$POSTER_PID" 2>/dev/null; then
    log "bam-poster exited before becoming ready"
    wait "$POSTER_PID" 2>/dev/null || true
    shutdown_children "$PG_PID"
    exit 1
  fi
  sleep 1
done

if ! curl -fsS -o /dev/null "http://127.0.0.1:${POSTER_PORT_LOCAL}/health"; then
  log "bam-poster did not become ready in time; aborting"
  shutdown_children "$POSTER_PID" "$PG_PID"
  exit 1
fi
log "bam-poster is ready"

log "starting bam-reader"
node /app/packages/bam-reader/dist/esm/bin/bam-reader.js serve &
READER_PID=$!

CHILDREN=("$PG_PID" "$POSTER_PID" "$READER_PID")

shutdown() {
  log "received shutdown signal, terminating children"
  shutdown_children "${CHILDREN[@]}"
  exit 0
}
trap shutdown SIGTERM SIGINT

# Wait until any child exits, then bring everything down.
set +e
wait -n "${CHILDREN[@]}"
EXIT_CODE=$?
set -e
log "child process exited (code ${EXIT_CODE}); shutting down container"
shutdown_children "${CHILDREN[@]}"
# Reaching this branch means a supervised child exited unexpectedly
# (intentional shutdown is handled by the SIGTERM/SIGINT trap, which
# exits 0 directly). If the child exited with status 0 — e.g. one of
# the services finished early — surface that as a failure so the
# orchestrator restarts the container instead of treating "service
# vanished cleanly" as success.
if [ "$EXIT_CODE" -eq 0 ]; then
  EXIT_CODE=1
fi
exit "$EXIT_CODE"
