#!/usr/bin/env bash
# Prepends a dated entry for the pushed commit range to CHANGELOG.md.
set -euo pipefail

ZERO="0000000000000000000000000000000000000000"
if [ -z "${BEFORE:-}" ] || [ "$BEFORE" = "$ZERO" ] || ! git cat-file -e "$BEFORE" 2>/dev/null; then
  RANGE="$AFTER"            # first push or force-push: log just the head commit
  FILES=$(git show --name-status --format= "$AFTER")
  COMMITS=$(git log -1 --format='- %s (`%h`, %an)' "$AFTER")
else
  RANGE="$BEFORE..$AFTER"
  FILES=$(git diff --name-status "$BEFORE" "$AFTER")
  COMMITS=$(git log --reverse --format='- %s (`%h`, %an)' "$RANGE")
fi

ENTRY=$(mktemp)
{
  echo "## $(date -u +'%Y-%m-%d %H:%M UTC') ? pushed by ${ACTOR:-unknown}"
  echo
  echo "### Commits"
  echo "$COMMITS"
  echo
  echo "### Files changed"
  echo "$FILES" | awk -F'\t' 'NF{ s=$1; sub(/^R.*/,"R",s); m=(s=="A")?"added":(s=="D")?"deleted":(s=="R")?"renamed":"modified"; printf "- %s: `%s`\n", m, $NF }' | grep -v '`CHANGELOG.md`' || true
  echo
} > "$ENTRY"

HEADER=$'# Changelog\n\nAutomatically updated on every push to `main` (see `.github/workflows/changelog.yml`).\n'
if [ -f CHANGELOG.md ]; then
  BODY=$(tail -n +4 CHANGELOG.md)
else
  BODY=""
fi
{ echo "$HEADER"; cat "$ENTRY"; echo "$BODY"; } > CHANGELOG.md
