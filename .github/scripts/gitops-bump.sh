#!/usr/bin/env bash
# Points an environment at a commit: sets global.imageTag in its values file of
# Dembrane/echo-gitops' helm/dembrane-web and pushes the commit to the branch Argo CD tracks.
# Called by .github/workflows/platform.yml after the images are pushed.
#
#   gitops-bump.sh <echo-gitops checkout> <branch> prod <sha> <release tag>
#   gitops-bump.sh <echo-gitops checkout> <branch> echo-next <sha>
#
# prod writes values-prod.yaml. echo-next writes values-echo-next.yaml, which only the
# dembrane-web-dummy app on the dev cluster reads, layered over values-prod.yaml: an echo-next
# rollout never changes what prod renders.
#
# The checkout must be on <branch>. A tag that is already set is left alone (a rerun commits
# nothing). PUSH=0 commits locally and prints the commit instead of pushing it.
set -euo pipefail
dir=${1:?echo-gitops checkout} branch=${2:?branch} env=${3:?prod or echo-next} sha=${4:?sha}
case "$env" in
  prod) file=helm/dembrane-web/values-prod.yaml label="${5:?release tag} ($sha)" ;;
  echo-next) file=helm/dembrane-web/values-echo-next.yaml label=$sha ;;
  *) echo "unknown environment: $env" >&2; exit 2 ;;
esac
values=$dir/$file
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "not a commit sha: $sha" >&2; exit 2; }
[ -f "$values" ] || { echo "$file is not in $dir (branch $branch)" >&2; exit 1; }

# Only the imageTag directly under the top-level global: block.
tmp=$(mktemp)
awk -v tag="$sha" '
  /^[^[:space:]#]/ { in_global = ($0 ~ /^global:[[:space:]]*$/) }
  in_global && /^[[:space:]]+imageTag:/ { sub(/imageTag:.*/, "imageTag: \"" tag "\""); n++ }
  { print }
  END { if (n != 1) { print "expected one global.imageTag, found " n+0 > "/dev/stderr"; exit 1 } }
' "$values" >"$tmp"
if cmp -s "$tmp" "$values"; then
  rm -f "$tmp"
  echo "$env: global.imageTag is already $sha on $branch; nothing to commit"
  exit 0
fi
mv "$tmp" "$values"
grep -Eq "^[[:space:]]+imageTag: \"$sha\"$" "$values" || { echo "global.imageTag did not change" >&2; exit 1; }

cd "$dir"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$file"
git commit -q -m "Update $env image tag to $label"
if [ "${PUSH:-1}" = 0 ]; then
  git --no-pager show --stat --format='%an <%ae>%n%s' HEAD
  git --no-pager diff HEAD~1 -- "$file"
  exit 0
fi
# Another commit may land on the branch between checkout and push: rebase onto it and retry.
for try in 1 2 3 4 5; do
  if git push -q origin "HEAD:$branch"; then
    echo "echo-gitops $branch: $env global.imageTag=$sha"
    exit 0
  fi
  echo "push to $branch rejected (try $try); rebasing" >&2
  git pull -q --rebase origin "$branch"
done
echo "could not push to echo-gitops $branch" >&2
exit 1
