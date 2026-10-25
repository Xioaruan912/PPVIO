#!/usr/bin/env bash
set -Eeuo pipefail

# One-time adoption of the service that ran as `tgvio-player` (TGVIO's player).
# Called by remote_release.sh, holding its lock, when /root/ppvio/ppvio.env does
# not exist yet.
#
#  1. consistent SQLite backup of the old database (backup API, never cp)
#  2. ppvio.env from player.env: TGVIO_PLAYER_* -> PPVIO_*; WebDAV keys the
#     server no longer reads are dropped (storage lives in the settings page)
#  3. stop tgvio-player (kept, not removed), move its data directory into
#     /root/ppvio (same filesystem: a rename, the byte cache is not copied)
#  4. start ppvio on the same loopback port; on any failure undo all of it and
#     start tgvio-player again
#
# usage: adopt_tgvio_player.sh RELEASE_DIR IMAGE_ID COMMIT

PPVIO_ROOT=/root/ppvio
LEGACY_ROOT=/root/tgvio-player
LEGACY_CONTAINER=tgvio-player
ENV_FILE="$PPVIO_ROOT/ppvio.env"
HEALTH_URL=http://127.0.0.1:8790/healthz

fail() { printf 'ppvio_release_failed: adopt: %s\n' "$1" >&2; exit 1; }
[[ $# -eq 3 ]] || fail "usage: $0 RELEASE_DIR IMAGE_ID COMMIT"
release_dir=$1 image_id=$2 commit=$3
[[ -d "$release_dir/source/scripts" ]] || fail "release source missing"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid image id"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid commit"
umask 077

legacy_env="$LEGACY_ROOT/player.env"
legacy_data="$LEGACY_ROOT/data"
[[ -f "$legacy_env" && ! -L "$legacy_env" ]] || fail "$legacy_env missing"
[[ -d "$legacy_data" && ! -L "$legacy_data" ]] || fail "$legacy_data missing"
[[ ! -e "$PPVIO_ROOT/data" && ! -e "$ENV_FILE" ]] || fail "PPVIO already has data or an env file"
[[ "$(stat -c '%d' "$legacy_data")" == "$(stat -c '%d' "$PPVIO_ROOT")" ]] || fail "data must move within one filesystem"
legacy_image=$(docker inspect --format '{{.Image}}' "$LEGACY_CONTAINER") || fail "$LEGACY_CONTAINER is not inspectable"

neighbour() { docker inspect --format '{{.Id}} {{.RestartCount}}' tgvio 2>/dev/null || printf 'absent\n'; }
bot_before=$(neighbour)

rollback_dir="$PPVIO_ROOT/adopt-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$rollback_dir"
printf '%s\n' "$legacy_image" >"$rollback_dir/tgvio-player-image.id"
cp -p "$legacy_env" "$rollback_dir/player.env"
python3 - "$legacy_data/player.sqlite3" "$rollback_dir/player.sqlite3.before" <<'PY'
import sqlite3, sys
source, target = sys.argv[1], sys.argv[2]
with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as live, sqlite3.connect(target) as copy:
    live.backup(copy)
    if copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("database backup quick_check failed")
PY

# Renamed configuration. Values are copied, never printed.
python3 - "$legacy_env" "$ENV_FILE.next" "$image_id" "$PPVIO_ROOT/data" <<'PY'
import sys
source, target, image, data_dir = sys.argv[1:]
dropped = {"WEBDAV_URL", "WEBDAV_USER", "WEBDAV_PASSWORD", "REMOTE_ROOT"}
lines = []
for raw in open(source, encoding="utf-8").read().splitlines():
    if not raw.startswith("TGVIO_PLAYER_") or "=" not in raw:
        continue
    key, value = raw[len("TGVIO_PLAYER_"):].split("=", 1)
    if key in dropped:
        continue
    if key == "IMAGE":
        value = image
    elif key == "HOST_DATA_DIR":
        value = data_dir
    lines.append(f"PPVIO_{key}={value}")
if not any(line.startswith("PPVIO_ENABLED=true") for line in lines):
    raise SystemExit("legacy env does not enable the player")
with open(target, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
PY
chmod 600 "$ENV_FILE.next"

restore() {
  printf 'ppvio_adopt: restoring tgvio-player\n' >&2
  docker rm -f ppvio >/dev/null 2>&1 || true
  if [[ -d "$PPVIO_ROOT/data" && ! -e "$legacy_data" ]]; then mv "$PPVIO_ROOT/data" "$legacy_data"; fi
  rm -f "$ENV_FILE" "$ENV_FILE.next"
  docker start "$LEGACY_CONTAINER" >/dev/null || true
}

stage=stop-legacy
trap 'printf "ppvio_release_failed: adopt stage=%s\n" "$stage" >&2; restore' ERR
docker stop --time 30 "$LEGACY_CONTAINER" >/dev/null
mv "$legacy_data" "$PPVIO_ROOT/data"
mv "$ENV_FILE.next" "$ENV_FILE"

stage=start-ppvio
bash "$release_dir/source/scripts/deploy.sh" --env-file "$ENV_FILE" --execute

stage=health
healthy=false
for _ in $(seq 1 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' ppvio 2>/dev/null || true)
  if [[ "$status" == healthy ]] && curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || { stage=health; false; }
[[ "$(docker inspect --format '{{.Image}}' ppvio)" == "$image_id" ]] || { stage=verify-image; false; }
[[ "$(neighbour)" == "$bot_before" ]] || { stage=verify-neighbour; false; }
python3 - "$PPVIO_ROOT/data/player.sqlite3" <<'PY' || { stage=verify-database; false; }
import sqlite3, sys
with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as db:
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit(1)
PY
trap - ERR

ln -sfn "$release_dir" "$PPVIO_ROOT/current"
printf '%s\n' "$commit" >"$PPVIO_ROOT/.release-commit"
printf 'ppvio_release=complete adopted_from=%s image=%s container=%s rollback=%s legacy_container=stopped\n' \
  "$LEGACY_CONTAINER" "$image_id" "$(docker inspect --format '{{.Id}}' ppvio)" "$rollback_dir"
