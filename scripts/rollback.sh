#!/usr/bin/env bash
set -Eeuo pipefail

# This only replaces ppvio with an explicitly supplied prior image.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/docker-compose.yml"

usage() {
  printf 'usage: %s --env-file PLAYER_ENV --image PRIOR_PLAYER_IMAGE --execute\n' "$0" >&2
  exit 2
}

env_file=
image=
execute=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) env_file=${2:-}; shift 2 ;;
    --image) image=${2:-}; shift 2 ;;
    --execute) execute=true; shift ;;
    *) usage ;;
  esac
done
[[ "$execute" == true && -n "$env_file" && -n "$image" ]] || usage
[[ -f "$env_file" && ! -L "$env_file" ]] || { printf 'Player env file is missing or a symlink\n' >&2; exit 2; }
[[ "$(stat -c '%a' "$env_file")" == 600 ]] || { printf 'Player env file must have mode 0600\n' >&2; exit 2; }
[[ "$env_file" != "$repo_root/.env" ]] || { printf 'refusing the Bot environment file\n' >&2; exit 2; }
grep -qx 'PPVIO_ENABLED=true' "$env_file" || {
  printf 'Player env file must explicitly set PPVIO_ENABLED=true\n' >&2
  exit 2
}
[[ "$image" != *$'\n'* ]] || { printf 'invalid Player image reference\n' >&2; exit 2; }
forbidden='^(BOT_TOKEN|API_ID|API_HASH|DEST_CHANNEL|ALLOWED_USERS|TGVIO_(DATA|DOWNLOAD|SESSION|LOG)_DIR)='
if grep -Eq "$forbidden" "$env_file"; then
  printf 'Player env file contains a Bot-only variable\n' >&2
  exit 2
fi
docker image inspect "$image" >/dev/null

# PPVIO shares the host with other services (the TGVIO bot runs as `tgvio`).
# Whatever else runs there must be untouched by this switch.
neighbour() { docker inspect --format '{{.Id}} {{.RestartCount}}' tgvio 2>/dev/null || printf 'absent\n'; }
bot_before=$(neighbour)

temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
sed "s|^PPVIO_IMAGE=.*$|PPVIO_IMAGE=$image|" "$env_file" >"$temporary"
chmod 600 "$temporary"
docker compose --project-name ppvio --env-file "$temporary" -f "$compose_file" --profile ppvio \
  up -d --no-build --pull never --force-recreate --no-deps ppvio

[[ "$(neighbour)" == "$bot_before" ]] || {
  printf 'PPVIO rollback changed the tgvio container; investigate before further actions\n' >&2
  exit 1
}
printf 'ppvio_rollback=started neighbour_unchanged=true\n'
