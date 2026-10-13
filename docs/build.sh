#!/usr/bin/env bash
# Build the dembrane documentation site with folder2website, the builder the docs workflow
# uses (.github/workflows/docs.yml pins the same commit).
#
#   ./docs/build.sh            # build to docs/_site
#   ./docs/build.sh --serve    # live preview on http://localhost:4321
#
# Convention: page.md is the default locale (en-UK); page.nl-NL.md is a translation twin.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILDER=github:spashii/folder2website#f20082056062d7c0fb825ce2529ccf07df33845f

bunx "$BUILDER" "$HERE" --out "$HERE/_site" "$@"
