#!/usr/bin/env bash
# Deploys the Remix Lab libraries and reference realms, in dependency order,
# without test files. Defaults target the Onyx testnet; override with env vars:
#
#   KEY=mainclock CHAIN_ID=onyx-1 REMOTE=https://rpc.onyx.testnets.gno.land:443 scripts/deploy.sh
#
# Packages that already exist on chain are skipped, so the script can be
# rerun after a failure; scripts/verify-deploy.ts then compares what is on
# chain with the local runtime files. The key must be the one whose address
# is in the package paths (g1lnky...), which also becomes the owner of each
# reference realm through init.
set -euo pipefail

KEY=${KEY:-mainclock}
CHAIN_ID=${CHAIN_ID:-onyx-1}
REMOTE=${REMOTE:-https://rpc.onyx.testnets.gno.land:443}
GNOKEY=${GNOKEY:-gnokey}
GAS_WANTED=${GAS_WANTED:-80000000}
GAS_FEE=${GAS_FEE:-100000ugnot}
MAX_DEPOSIT=${MAX_DEPOSIT:-100000000ugnot}

A=g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm
PKGS=(
  p/$A/remixlab/core/v1
  p/$A/remixlab/render/v1
  p/$A/remixlab/membership/v1
  p/$A/remixlab/policies/v1
  p/$A/remixlab/forms/v1
  p/$A/remixlab/ballots/v1
  r/$A/remixlab/clubpoll
  r/$A/remixlab/directory
  r/$A/remixlab/contest
  r/$A/remixlab/sharedmembers
  r/$A/remixlab/sharedpoll
)

root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# exists succeeds only when the node positively reports the package. Any
# failure (network, RPC error) counts as "not deployed"; addpkg then
# simulates first, so a package that does exist makes the script stop
# rather than deploy twice.
exists() {
  local data
  data=$(printf %s "gno.land/$1" | base64 | tr -d '\n')
  curl -sS --max-time 20 "${REMOTE}/abci_query?path=%22vm/qfile%22&data=%22${data}%22" 2>/dev/null |
    grep -Eq '"Error": ?null'
}

read -rsp "Password for key ${KEY}: " PASSWORD
echo

for p in "${PKGS[@]}"; do
  if exists "$p"; then
    echo "skip   gno.land/$p (already deployed)"
    continue
  fi
  dir="$stage/$p"
  mkdir -p "$dir"
  find "$root/gno/$p" -maxdepth 1 -type f \( -name '*.gno' -o -name gnomod.toml \) \
    ! -name '*_test.gno' ! -name '*_filetest.gno' -exec cp {} "$dir/" \;
  [ -f "$dir/gnomod.toml" ] || { echo "missing $root/gno/$p/gnomod.toml" >&2; exit 1; }
  echo "deploy gno.land/$p"
  printf '%s\n' "$PASSWORD" | "$GNOKEY" maketx addpkg \
    -pkgdir "$dir" -pkgpath "gno.land/$p" \
    -gas-wanted "$GAS_WANTED" -gas-fee "$GAS_FEE" -max-deposit "$MAX_DEPOSIT" \
    -broadcast -chainid "$CHAIN_ID" -remote "$REMOTE" \
    -insecure-password-stdin "$KEY"
done

echo "Done: ${REMOTE%%:443} / chain ${CHAIN_ID}"
echo "Verify with: node scripts/verify-deploy.ts --remote ${REMOTE} --network ${CHAIN_ID}"
