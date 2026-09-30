#!/usr/bin/env bash
#
# Install the mercelle skill into every agent skill directory on this machine.
#
# Uses real file copies (not symlinks) because that is how the other skills in
# ~/.claude/skills and ~/.agents/skills are stored. Both destinations are
# updated so a skill stays consistent across agents.
#
# Usage:  ./skill/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/SKILL.md"

if [ ! -f "$SKILL_FILE" ]; then
  echo "error: $SKILL_FILE not found" >&2
  exit 1
fi

# Directories that hold agent skills. Each must exist already; we do not create
# config trees for tools that are not installed.
#
# Claude Code and the shared `.agents` tree hold real skills (SKILL.md). Cline,
# Gemini, Cursor and Agy read flat rule files, so those get AGENTS.md instead —
# same instructions, the format each tool actually looks for.
TARGETS=(
  "$HOME/.claude/skills/mercelle"
  "$HOME/.agents/skills/mercelle"
  "$HOME/.agy/skills/mercelle"
  "$HOME/.freebuff/skills/mercelle"
)

# Flat-instruction agents: <parent>/AGENTS.md
RULE_TARGETS=(
  "$HOME/.claude/CLAUDE.md"
  "$HOME/.cline/AGENTS.md"
  "$HOME/.gemini/GEMINI.md"
  "$HOME/.cursor/rules/mercelle.md"
  "$HOME/.agy/AGENTS.md"
  "$HOME/.freebuff/AGENTS.md"
)

installed=0
for target in "${TARGETS[@]}"; do
  # Only write into a skills root that already exists.
  parent="$(dirname "$target")"
  if [ ! -d "$parent" ]; then
    echo "skip  $target  (no $parent)"
    continue
  fi

  mkdir -p "$target"
  cp "$SKILL_FILE" "$target/SKILL.md"
  echo "ok    $target/SKILL.md"
  installed=$((installed + 1))
done

rules=0
for target in "${RULE_TARGETS[@]}"; do
  parent="$(dirname "$target")"
  if [ ! -d "$parent" ]; then
    echo "skip  $target  (no $parent)"
    continue
  fi
  # Merge rather than clobber: an agent's own rules file may already hold
  # instructions we know nothing about.
  if [ -f "$target" ] && ! grep -q 'mercelle — verify code in real Linux' "$target"; then
    cat "$SKILL_FILE" >> "$target"
  elif [ ! -f "$target" ]; then
    cp "$SKILL_FILE" "$target"
  fi
  echo "ok    $target"
  rules=$((rules + 1))
done

if [ "$installed" -eq 0 ] && [ "$rules" -eq 0 ]; then
  echo "warning: no agent skill directories found; nothing installed" >&2
  exit 1
fi

echo
echo "Installed to $installed skill location(s) and $rules rules file(s)."
echo "Start a new agent session to pick them up."
