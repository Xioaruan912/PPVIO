#!/usr/bin/env bash
# Everything a change must pass: source tree and architecture guard, Python tests,
# and the front end's type check, tests and build (web/).
set -Eeuo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python_bin=${PYTHON:-python3}
if [[ -x "$repo_root/.venv/bin/python" ]]; then python_bin="$repo_root/.venv/bin/python"; fi

"$python_bin" "$repo_root/scripts/guard.py"
git -C "$repo_root" diff --check
for script in "$repo_root"/scripts/*.sh; do bash -n "$script"; done

export PYTHONPATH="$repo_root/src:${PYTHONPATH:-}"
"$python_bin" -m unittest discover -s "$repo_root/tests" -t "$repo_root/tests"

npm --prefix "$repo_root/web" ci --no-audit --no-fund
npm --prefix "$repo_root/web" run check
printf 'ppvio_checks=passed python=%s\n' "$("$python_bin" --version 2>&1)"
