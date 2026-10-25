#!/usr/bin/env bash
set -Eeuo pipefail

# Runs on HostDZire from an uploaded, hash-verified release source. PPVIO only:
# it never invokes the Bot compose file, and it proves the Bot container is
# unchanged. Every switch keeps a rollback point (prior image, env, SQLite backup)
# and a failed health check rolls back to the prior image automatically.
#
# usage: remote_release.sh RELEASE_ID COMMIT WEB_COMMIT IMAGE_SHA256 SOURCE_SHA256
#
# Image IDs are not portable between Docker image stores (classic overlay2 IDs are the
# config digest, the containerd store uses the manifest digest), so identity is the
# SHA-256 of the transferred archive plus the two provenance labels, and the ID that
# runs is the one this host computes after loading.

PLAYER_ROOT=/root/ppvio
ENV_FILE="$PLAYER_ROOT/ppvio.env"
DATA_DB="$PLAYER_ROOT/data/player.sqlite3"
HEALTH_URL=http://127.0.0.1:8790/healthz

fail() { printf 'ppvio_release_failed: %s\n' "$1" >&2; exit 1; }
[[ $# -eq 5 ]] || { printf 'usage: %s RELEASE_ID COMMIT WEB_COMMIT IMAGE_SHA256 SOURCE_SHA256\n' "$0" >&2; exit 2; }
release_id=$1 commit=$2 web_commit=$3 image_sha=$4 source_sha=$5
[[ "$release_id" =~ ^ppvio-[0-9a-f]{7}-[0-9]{8}T[0-9]{6}Z$ ]] || fail "invalid release id"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid commit"
[[ "$web_commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid front-end commit"
[[ "$image_sha" =~ ^[0-9a-f]{64}$ && "$source_sha" =~ ^[0-9a-f]{64}$ ]] || fail "invalid transfer hash"

release_dir="$PLAYER_ROOT/releases/$release_id"
[[ -d "$release_dir/incoming" && ! -L "$release_dir" ]] || fail "release directory missing: $release_dir"
# The first release adopts the service that ran as tgvio-player (scripts/adopt_tgvio_player.sh).
LEGACY_ROOT=/root/tgvio-player
adopt=false
if [[ ! -e "$ENV_FILE" ]]; then
  [[ -f "$LEGACY_ROOT/player.env" && -d "$LEGACY_ROOT/data" && ! -e "$PLAYER_ROOT/data" ]] \
    || fail "ppvio.env is missing and there is no tgvio-player to adopt"
  adopt=true
else
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && "$(stat -c '%a' "$ENV_FILE")" == 600 ]] || fail "ppvio.env must be a 0600 regular file"
fi
umask 077

# One release at a time.
exec 9>"$PLAYER_ROOT/.deploy.lock"
flock -n 9 || fail "another Player release holds the lock"

stage=verify-transfer
trap 'printf "ppvio_release_failed stage=%s\n" "$stage" >&2' ERR
[[ "$(sha256sum "$release_dir/incoming/ppvio-image.tar.gz" | cut -d' ' -f1)" == "$image_sha" ]] || fail "image transfer hash mismatch"
[[ "$(sha256sum "$release_dir/incoming/source.tar.gz" | cut -d' ' -f1)" == "$source_sha" ]] || fail "source transfer hash mismatch"
mkdir -p "$release_dir/source"
[[ -z "$(ls -A "$release_dir/source")" ]] || fail "release source is not empty"
tar -xzf "$release_dir/incoming/source.tar.gz" -C "$release_dir/source"

stage=load-image
gunzip -c "$release_dir/incoming/ppvio-image.tar.gz" | docker load >/dev/null
tag="ppvio:$release_id"
image_id=$(docker image inspect --format '{{.Id}}' "$tag") || fail "the loaded archive did not provide $tag"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")" == "$commit" ]] \
  || fail "image revision label does not match the release commit"
[[ "$(docker image inspect --format '{{index .Config.Labels "io.ppvio.web.revision"}}' "$tag")" == "$web_commit" ]] \
  || fail "image front-end label does not match the release commit"

if [[ "$adopt" == true ]]; then
  trap - ERR
  exec bash "$release_dir/source/scripts/adopt_tgvio_player.sh" "$release_dir" "$image_id" "$commit"
fi

stage=rollback-point
neighbour() { docker inspect --format '{{.Id}} {{.RestartCount}}' tgvio 2>/dev/null || printf 'absent\n'; }
bot_before=$(neighbour)
previous_image=$(sed -n 's/^PPVIO_IMAGE=//p' "$ENV_FILE")
[[ -n "$previous_image" ]] && docker image inspect "$previous_image" >/dev/null || fail "prior Player image is not available for rollback"
rollback_dir="$PLAYER_ROOT/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$rollback_dir"
docker inspect --format '{{.Id}}' ppvio >"$rollback_dir/player-container.id" 2>/dev/null || : >"$rollback_dir/player-container.id"
printf '%s\n' "$previous_image" >"$rollback_dir/player-image.id"
cp -p "$ENV_FILE" "$rollback_dir/ppvio.env"
# A consistent copy through the SQLite backup API, never a cp of the live file.
python3 - "$DATA_DB" "$rollback_dir/player.sqlite3.before" <<'PY'
import sqlite3, sys
source, target = sys.argv[1], sys.argv[2]
with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as live, sqlite3.connect(target) as copy:
    live.backup(copy)
    if copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("database backup quick_check failed")
PY

stage=switch
next_env="$release_dir/ppvio.env.deploy"
sed "s|^PPVIO_IMAGE=.*$|PPVIO_IMAGE=$image_id|" "$ENV_FILE" >"$next_env"
chmod 600 "$next_env"
bash "$release_dir/source/scripts/deploy.sh" --env-file "$next_env" --execute

stage=health
healthy=false
for _ in $(seq 1 45); do
  status=$(docker inspect --format '{{.State.Health.Status}}' ppvio 2>/dev/null || true)
  if [[ "$status" == healthy ]] && curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then healthy=true; break; fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  stage=auto-rollback
  printf 'ppvio_release: new image is not healthy; rolling back to %s\n' "$previous_image" >&2
  bash "$release_dir/source/scripts/rollback.sh" --env-file "$ENV_FILE" --image "$previous_image" --execute
  fail "health check failed; rolled back to the prior image"
fi

stage=post-verify
[[ "$(docker inspect --format '{{.Image}}' ppvio)" == "$image_id" ]] || fail "running Player image is not the release image"
[[ "$(neighbour)" == "$bot_before" ]] || fail "the tgvio container changed during a PPVIO release"
python3 - "$DATA_DB" <<'PY'
import sqlite3, sys
with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as db:
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("player database quick_check failed after the switch")
PY

# The new env becomes the live one only after the switch proved healthy.
cp -p "$next_env" "$ENV_FILE.next" && mv -f "$ENV_FILE.next" "$ENV_FILE"
ln -sfn "$release_dir" "$PLAYER_ROOT/current"
printf '%s\n' "$commit" >"$PLAYER_ROOT/.release-commit"
trap - ERR
printf 'ppvio_release=complete release=%s image=%s container=%s rollback=%s bot_unchanged=true\n' \
  "$release_id" "$image_id" "$(docker inspect --format '{{.Id}}' ppvio)" "$rollback_dir"
