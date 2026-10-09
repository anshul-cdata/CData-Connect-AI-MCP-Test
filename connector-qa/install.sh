#!/usr/bin/env bash
# install.sh - install the connector-qa skill into Claude Code on macOS / Linux.
# Mirrors install.ps1. Copies the runtime part of this folder to ~/.claude/skills/connector-qa/
# and points output at a root folder (default: this folder's parent), writing the
# machine-specific path into the INSTALLED config.json only. The shared copy keeps `root` empty.
#
# Only the runtime is installed: SKILL.md, config.json, LICENSE.txt, agents, assets, references,
# schemas and scripts. Documents, tests, evals, node_modules and `_` scratch files stay here.
#
#   ./install.sh                 # root = parent of this folder
#   ./install.sh --root ~/qa     # explicit root
#   ./install.sh --link          # symlink instead of copy (edits take effect immediately)
#   ./install.sh --uninstall
set -euo pipefail

SKILL=connector-qa
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.claude/skills/$SKILL"
NODE_MAJOR=20
RUNTIME="SKILL.md config.json LICENSE.txt agents assets references schemas scripts"
DEV_ONLY="scripts/sync-skill.mjs"
# zsh (the macOS default) never reads ~/.profile, so the variable goes where the shell will see it
PROFILES="$HOME/.profile"
case "${SHELL:-}" in *zsh) PROFILES="$PROFILES $HOME/.zprofile";; esac
ROOT=""; LINK=0; UNINSTALL=0
while [ $# -gt 0 ]; do case "$1" in
  --root) ROOT="$2"; shift 2;; --link) LINK=1; shift;; --uninstall) UNINSTALL=1; shift;;
  *) echo "unknown flag $1"; exit 2;; esac; done

ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }
bad()  { printf '  [fail] %s\n' "$*"; }
# remove the CONNECTOR_QA_ROOT line without leaving a .bak behind (sed -i differs on macOS)
strip_var() { [ -f "$1" ] || return 0; grep -v CONNECTOR_QA_ROOT "$1" > "$1.tmp" || true; mv "$1.tmp" "$1"; }
echo; echo "connector-qa installer"; echo

if [ "$UNINSTALL" = 1 ]; then
  if [ -L "$TARGET" ]; then rm -f "$TARGET"; ok "removed link $TARGET"
  elif [ -d "$TARGET" ]; then rm -rf "$TARGET"; ok "removed $TARGET"
  else echo "  nothing installed at $TARGET"; fi
  for p in $PROFILES; do strip_var "$p"; done
  ok "cleared CONNECTOR_QA_ROOT from your shell profile"
  echo "  your project folder and all test output were left untouched."; echo; exit 0
fi

for req in $RUNTIME; do
  [ -e "$SRC/$req" ] || { bad "missing '$req' - run this from inside the skill folder."; exit 1; }
done
ok "source looks complete: $SRC"

# prerequisites, checked before anything is changed. Node is not optional: gap arithmetic,
# coverage crediting and report building are Node scripts.
command -v node >/dev/null 2>&1 || {
  bad "node not found on PATH."
  echo "  install Node $NODE_MAJOR LTS or newer from https://nodejs.org, open a new shell, and re-run."; exit 1; }
v="$(node --version | sed 's/^v//')"
[ "${v%%.*}" -ge "$NODE_MAJOR" ] || { bad "node $v is too old - the scripts need Node $NODE_MAJOR or newer."; exit 1; }
ok "node $v"

[ -n "$ROOT" ] || ROOT="$(dirname "$SRC")"
mkdir -p "$ROOT" || { bad "cannot create output root: $ROOT"; exit 1; }
ROOT="$(cd "$ROOT" && pwd)"
touch "$ROOT/.writetest" && rm "$ROOT/.writetest" || { bad "output root is not writable: $ROOT"; exit 1; }
ok "output root: $ROOT"
mkdir -p "$ROOT/_querydumps"; echo "  shared dump folder ready: $ROOT/_querydumps"

mkdir -p "$(dirname "$TARGET")"
if [ -L "$TARGET" ]; then rm -f "$TARGET"; echo "  replaced existing link"
elif [ -e "$TARGET" ]; then rm -rf "$TARGET"; echo "  replaced existing install"; fi

if [ "$LINK" = 1 ]; then
  ln -s "$SRC" "$TARGET"; ok "linked $TARGET -> $SRC"
  warn "config.root stays empty in a linked install; CONNECTOR_QA_ROOT points at your output folder."
else
  mkdir -p "$TARGET"
  for item in $RUNTIME; do cp -R "$SRC/$item" "$TARGET/"; done
  for dev in $DEV_ONLY; do rm -f "$TARGET/$dev"; done
  node -e "const f=process.argv[1],c=JSON.parse(require('fs').readFileSync(f,'utf8'));c.root=process.argv[2];require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n')" "$TARGET/config.json" "$ROOT"
  ok "installed to $TARGET"; ok "installed config.root set to your output folder"
  # remember where this copy came from, so every run can notice a newer source (scripts/check-version.mjs)
  node -e "const fs=require('fs'),v=JSON.parse(fs.readFileSync(process.argv[2]+'/config.json','utf8')).version;fs.writeFileSync(process.argv[1]+'/install-info.json',JSON.stringify({source:process.argv[2],version:v,installed_at:new Date().toISOString()},null,2)+'\n');console.log('  installed version '+v)" "$TARGET" "$SRC"
  node "$TARGET/scripts/check-version.mjs" --stamp "$SRC"
fi

for p in $PROFILES; do
  strip_var "$p"
  printf '\nexport CONNECTOR_QA_ROOT="%s"\n' "$ROOT" >> "$p"
done
export CONNECTOR_QA_ROOT="$ROOT"
ok "CONNECTOR_QA_ROOT set in ${PROFILES// /, } (open a new shell to pick it up)"

failed=0
[ -s "$TARGET/assets/report-template.html" ] && ok "report template present" || { bad "report template missing"; failed=1; }
for t in capability-report-template.html eval-report-template.html; do
  [ -s "$TARGET/assets/$t" ] && ok "$t present" || { bad "$t missing"; failed=1; }
done
refs=$(ls "$TARGET/references"/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$refs" -ge 11 ] && ok "$refs reference files" || { bad "expected 11+ reference files, found $refs"; failed=1; }
agents=$(ls "$TARGET/agents"/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$agents" -ge 4 ] && ok "$agents research agents" || { bad "expected 4 agents, found $agents"; failed=1; }
scripts=$(ls "$TARGET/scripts"/*.mjs 2>/dev/null | wc -l | tr -d ' ')
[ "$scripts" -ge 12 ] && ok "$scripts scripts" || { bad "expected 12+ scripts, found $scripts"; failed=1; }
if chk="$(node "$TARGET/scripts/check-skill.mjs" "$TARGET" 2>&1)"; then
  ok "check-skill: references resolve, scripts parse, config valid"
else
  bad "check-skill reported problems:"; printf '%s\n' "$chk" | tail -8 | sed 's/^/      /'; failed=1
fi

if [ "$failed" = 1 ]; then echo; echo "  NOT ready - fix the [fail] lines above and re-run."; echo; exit 1; fi

echo; echo "  Ready."; echo
echo "  Start a NEW Claude Code session, then run:"; echo "      /connector-qa <ConnectorName>"; echo
echo "  Reports land in  $ROOT/<ConnectorName>/"
echo "  Drop customer query dumps (.csv) in  $ROOT/_querydumps/  to enrich coverage."
[ "$LINK" = 1 ] || echo "  Edited the skill? Re-run this script to push changes to the installed copy."
echo
