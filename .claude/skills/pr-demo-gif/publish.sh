#!/usr/bin/env bash
# Host demo media for a PR on a `pr-assets` branch of the PR's head repo and
# print a Markdown image line for each file.
#
#   publish.sh <pr-number> <file>...
#
# The files become the *entire* contents of `pr-<number>/` on that branch:
# anything published there before is replaced, so re-publishing just the GIF
# also removes an old MP4. Other PRs' folders are kept. The feature branch and
# the working tree are never touched (git plumbing + a throwaway index).
#
# Each file is stored as <name>-<content hash>.<ext>, so a new recording gets a
# new URL and raw.githubusercontent.com's cache never serves the old one.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <pr-number> <file>..." >&2
  exit 2
fi
PR=$1; shift
BRANCH=pr-assets

# The branch lives where the PR's head lives (often a fork without write
# access to the base repo).
read -r OWNER NAME < <(gh pr view "$PR" --json headRepositoryOwner,headRepository \
  --jq '"\(.headRepositoryOwner.login) \(.headRepository.name)"')
SLUG="$OWNER/$NAME"
PUSH_URL=$(git remote -v | awk -v s="$SLUG" '$2 ~ "[:/]" s "(\\.git)?$" && $3 == "(push)" {print $2; exit}')
PUSH_URL=${PUSH_URL:-git@github.com:$SLUG.git}

VISIBILITY=$(gh repo view "$SLUG" --json visibility --jq .visibility)
echo "Publishing to $SLUG ($VISIBILITY), branch $BRANCH, folder pr-$PR/" >&2

PARENT=""
if git ls-remote --exit-code --heads "$PUSH_URL" "$BRANCH" >/dev/null 2>&1; then
  git fetch -q "$PUSH_URL" "$BRANCH"
  PARENT=$(git rev-parse FETCH_HEAD)
fi

INDEX=$(mktemp)
trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE=$INDEX
if [ -n "$PARENT" ]; then git read-tree "$PARENT"; else git read-tree --empty; fi
git rm -q -r --cached --ignore-unmatch "pr-$PR" >/dev/null

PATHS=()
for f in "$@"; do
  base=$(basename "$f"); stem=${base%.*}; ext=${base##*.}
  sha=$(git hash-object -w "$f")
  path="pr-$PR/$stem-${sha:0:8}.$ext"
  git update-index --add --cacheinfo "100644,$sha,$path"
  PATHS+=("$path")
done

TREE=$(git write-tree)
if [ -n "$PARENT" ]; then
  COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "Demo media for PR #$PR")
else
  COMMIT=$(git commit-tree "$TREE" -m "Demo media for PR #$PR")
fi
unset GIT_INDEX_FILE
git push -q "$PUSH_URL" "${COMMIT}:refs/heads/$BRANCH"

for path in "${PATHS[@]}"; do
  url="https://raw.githubusercontent.com/$SLUG/$BRANCH/$path"
  case $path in
    *.gif|*.png|*.jpg|*.jpeg|*.webp) echo "![Demo]($url)" ;;
    *) echo "[$(basename "$path")](https://github.com/$SLUG/raw/$BRANCH/$path)" ;;
  esac
done
