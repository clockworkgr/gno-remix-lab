#!/usr/bin/env bash
# Links the pinned Gno checkout into .toolchain/gno so the Go integration
# module can `replace` github.com/gnolang/gno with it.
#
# Usage: scripts/link-toolchain.sh [path-to-gno-checkout]
# Defaults to $GNOROOT, then `gno env GNOROOT`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
want="$(sed -n 's/^commit=//p' "$root/TOOLCHAIN")"
src="${1:-${GNOROOT:-$(gno env GNOROOT 2>/dev/null | tr -d '"' | sed 's/^GNOROOT=//')}}"

if [[ -z "$src" || ! -d "$src/gnovm" ]]; then
  echo "error: no Gno checkout found; pass its path or set GNOROOT" >&2
  exit 1
fi

have="$(git -C "$src" rev-parse --short=9 HEAD)"
if [[ "$have" != "$want"* ]]; then
  echo "warning: $src is at $have, TOOLCHAIN pins $want" >&2
  if [[ "${REMIX_ALLOW_TOOLCHAIN_MISMATCH:-}" != "1" ]]; then
    echo "set REMIX_ALLOW_TOOLCHAIN_MISMATCH=1 to continue anyway" >&2
    exit 1
  fi
fi

mkdir -p "$root/.toolchain"
ln -sfn "$src" "$root/.toolchain/gno"
echo "linked .toolchain/gno -> $src ($have)"
