#!/usr/bin/env bash
# Regenerate .claude/skills/ from agent-sops/*.sop.md.
# Only local SOPs are copied; the upstream built-ins (code-assist, pdd, ...)
# come from the agent-sops@agent-sop plugin instead, so keeping them out of
# .claude/skills/ avoids duplicate skills in Claude Code.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

uvx strands-agents-sops skills --sop-paths agent-sops --output-dir "$tmp" >/dev/null

mkdir -p .claude/skills
for sop in agent-sops/*.sop.md; do
  name=$(basename "$sop" .sop.md)
  rm -rf ".claude/skills/$name"
  cp -r "$tmp/$name" ".claude/skills/$name"
  echo "generated .claude/skills/$name"
done
