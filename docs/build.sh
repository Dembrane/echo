#!/usr/bin/env bash
# Build the dembrane documentation site with the (i18n-enhanced) folder2website.
#
#   ./docs/build.sh            # build to docs/_site
#   ./docs/build.sh --serve    # live preview on http://localhost:4321
#
# The tool is vendored + patched for languages at ../folder2website.
# Convention: page.md is the default locale (en-UK); page.nl-NL.md is a translation twin.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"          # docs/
TOOL="$(cd "$HERE/.." && pwd)/folder2website"  # vendored, i18n-enhanced
OUT="$HERE/_site"

bun "$TOOL/index.ts" "$HERE" --out "$OUT" "$@"
