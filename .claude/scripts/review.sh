#!/usr/bin/env bash
# 슬라이스 하나를 별도 워크트리의 새 Codex에게 독립 리뷰시킨다.
#
#   ./review.sh <슬라이스브랜치명> <리뷰프롬프트파일>
#
# 예) ./review.sh b2-schema review-B2.md
#
# 구현 워크트리와 분리된 신규 컨텍스트로 띄운다. 구현 의도를 주지 않고
# 수용 기준과 diff만 준다 — 의도를 알면 그 틀에 갇혀서 놓친다.

set -euo pipefail

SLICE="${1:?슬라이스 브랜치명이 필요하다 (예: b2-schema)}"
PROMPT_FILE="${2:?리뷰 프롬프트 파일 경로가 필요하다}"

[[ -f "$PROMPT_FILE" ]] || { echo "프롬프트 파일 없음: $PROMPT_FILE" >&2; exit 1; }

BRANCH="hoddukzoa12/$SLICE"
NAME="$SLICE-review"

# ── 리뷰 대상 브랜치가 원격에 있는지 확인 ────────────────────
git -C /Users/hoddukzoa/orca/projects/RichChat fetch -q origin
if ! git -C /Users/hoddukzoa/orca/projects/RichChat rev-parse --verify -q "origin/$BRANCH" >/dev/null; then
  echo "✗ origin/$BRANCH 가 없다. 구현자가 푸시했는지 확인해라." >&2
  exit 1
fi
echo "✓ 리뷰 대상: origin/$BRANCH ($(git -C /Users/hoddukzoa/orca/projects/RichChat rev-parse --short "origin/$BRANCH"))"

# ── 리뷰 워크트리 생성 ────────────────────────────────────────
OUT=$(orca worktree create --name "$NAME" --no-parent --base-branch "$BRANCH" --agent codex --json)
read -r WT_PATH HANDLE HEAD <<<"$(
  printf '%s' "$OUT" | python3 -c '
import json,sys; r=json.load(sys.stdin)["result"]
print(r["worktree"]["path"], (r.get("startupTerminal") or {}).get("handle",""), r["worktree"]["head"][:8])'
)"
echo "✓ 리뷰 워크트리: $WT_PATH"
echo "  head=$HEAD  terminal=$HANDLE"

orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 120000 --json >/dev/null

# ── 프롬프트 조립 (슬라이스별 + 리뷰 공통 꼬리말) ─────────────
DIR=$(cd "$(dirname "$PROMPT_FILE")" && pwd)
SPEC=$(mktemp)
cat "$PROMPT_FILE" > "$SPEC"
cat "$DIR/review-footer.md" >> "$SPEC"

TASK=$(orca orchestration task-create --json --spec "$(cat "$SPEC")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["task"]["id"])')
rm -f "$SPEC"

orca orchestration dispatch --task "$TASK" --to "$HANDLE" --inject --json >/dev/null
echo "✓ 리뷰 디스패치: $TASK → $HANDLE"

cat <<EOF

── $NAME ──
  task      $TASK
  terminal  $HANDLE
  worktree  $WT_PATH
EOF
