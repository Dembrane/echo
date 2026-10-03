#!/usr/bin/env bash
# Points production at a new release: sets global.imageTag in Dembrane/echo-gitops'
# helm/dembrane-web/values-prod.yaml and pushes the commit to the branch Argo CD tracks there.
# Called by .github/workflows/platform.yml (70-deploy-prod) after the images are pushed.
#
#   gitops-bump.sh <echo-gitops checkout> <branch> <sha> <release tag>
#
# The checkout must be on <branch>. A tag that is already set is left alone (a rerun commits
# nothing). PUSH=0 commits locally and prints the commit instead of pushing it.
set -euo pipefail
dir=${1:?echo-gitops checkout} branch=${2:?branch} sha=${3:?sha} release=${4:?release tag}
file=helm/dembrane-web/values-prod.yaml
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
  echo "global.imageTag is already $sha on $branch; nothing to commit"
  exit 0
fi
mv "$tmp" "$values"
grep -Eq "^[[:space:]]+imageTag: \"$sha\"$" "$values" || { echo "global.imageTag did not change" >&2; exit 1; }

cd "$dir"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$file"
git commit -q -m "Update prod image tag to $release ($sha)"
if [ "${PUSH:-1}" = 0 ]; then
  git --no-pager show --stat --format='%an <%ae>%n%s' HEAD
  git --no-pager diff HEAD~1 -- "$file"
  exit 0
fi
# Another commit may land on the branch between checkout and push: rebase onto it and retry.
for try in 1 2 3 4 5; do
  if git push -q origin "HEAD:$branch"; then
    echo "echo-gitops $branch: global.imageTag=$sha ($release)"
    exit 0
  fi
  echo "push to $branch rejected (try $try); rebasing" >&2
  git pull -q --rebase origin "$branch"
done
echo "could not push to echo-gitops $branch" >&2
exit 1
