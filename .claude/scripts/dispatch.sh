#!/usr/bin/env bash
# 슬라이스 하나를 워크트리 + Codex에 디스패치한다.
#
#   ./dispatch.sh <슬라이스명> <프롬프트파일> [기준브랜치]
#
# 예) ./dispatch.sh b1-shared-types prompt-B1.md
#     ./dispatch.sh b2-schema       prompt-B2.md
#
# 기준브랜치를 생략하면 origin/main에서 갈라진다.
# CLAUDE.md의 디스패치 절차를 그대로 구현한 것이다.

set -euo pipefail

NAME="${1:?슬라이스명이 필요하다}"
PROMPT_FILE="${2:?프롬프트 파일 경로가 필요하다}"
BASE="${3:-}"

REPO=/Users/hoddukzoa/orca/projects/RichChat
[[ -f "$PROMPT_FILE" ]] || { echo "프롬프트 파일 없음: $PROMPT_FILE" >&2; exit 1; }

# ── 1. origin/main 동기화 확인 ────────────────────────────────
# 워크트리는 원격 기준 브랜치에서 갈라진다. 푸시 안 된 커밋은 워크트리에 없다.
LOCAL=$(git -C "$REPO" rev-parse main)
REMOTE=$(git -C "$REPO" rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "✗ main이 origin/main과 다르다. 먼저 푸시해라." >&2
  echo "  local=${LOCAL:0:8} origin=${REMOTE:0:8}" >&2
  exit 1
fi
echo "✓ main 동기화 확인: ${LOCAL:0:8}"

# ── 2. 워크트리 + Codex 생성 ──────────────────────────────────
CREATE_ARGS=(--name "$NAME" --no-parent --agent codex --json)
[[ -n "$BASE" ]] && CREATE_ARGS+=(--base-branch "$BASE")

CREATE_OUT=$(orca worktree create "${CREATE_ARGS[@]}")
read -r WT_ID WT_PATH WT_HEAD HANDLE <<<"$(
  printf '%s' "$CREATE_OUT" | python3 -c '
import json,sys
r=json.load(sys.stdin)["result"]; w=r["worktree"]
print(w["id"], w["path"], w["head"][:8], (r.get("startupTerminal") or {}).get("handle",""))
'
)"
echo "✓ 워크트리: $WT_PATH"
echo "  head=$WT_HEAD  terminal=$HANDLE"

# ── 3. head 검증 ──────────────────────────────────────────────
EXPECT="${BASE:+$(git -C "$REPO" rev-parse "origin/${BASE#origin/}" 2>/dev/null || echo)}"
EXPECT="${EXPECT:-$REMOTE}"
if [[ "${EXPECT:0:8}" != "$WT_HEAD" ]]; then
  echo "⚠ head가 기대값과 다르다 (기대 ${EXPECT:0:8}, 실제 $WT_HEAD). 맞춘다." >&2
  git -C "$WT_PATH" reset --hard "$EXPECT" -q
  echo "✓ 재설정 완료"
fi

# ── 4. TUI 준비 대기 (프롬프트 유실 방지) ─────────────────────
orca terminal wait --terminal "$HANDLE" --for tui-idle --timeout-ms 120000 --json >/dev/null
echo "✓ 터미널 준비됨"

# ── 5. 프롬프트 조립 (헤더 + 슬라이스별 + 공통 꼬리말) ────────
# 커밋·푸시 지시와 ask 안내를 매번 손으로 쓰다 두 번 빠뜨렸다. 고정으로 붙인다.
DIR=$(cd "$(dirname "$PROMPT_FILE")" && pwd)
SPEC=$(mktemp)
sed "s|{{SLICE}}|$NAME|g" "$DIR/prompt-header.md" > "$SPEC"
cat "$PROMPT_FILE" >> "$SPEC"
cat "$DIR/prompt-footer.md" >> "$SPEC"
echo "✓ 프롬프트 조립: $(wc -l < "$SPEC")줄"

# ── 6. task 생성 + 디스패치 ───────────────────────────────────
TASK=$(orca orchestration task-create --json --spec "$(cat "$SPEC")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["task"]["id"])')
rm -f "$SPEC"
orca orchestration dispatch --task "$TASK" --to "$HANDLE" --inject --json >/dev/null
echo "✓ 디스패치: $TASK → $HANDLE"

# ── 6. 결과 요약 (대기는 호출자가 백그라운드로 건다) ──────────
cat <<EOF

── $NAME ──
  task      $TASK
  terminal  $HANDLE
  worktree  $WT_PATH
  branch    hoddukzoa12/$NAME

대기:
  orca orchestration check --wait --types worker_done,escalation,decision_gate \\
    --timeout-ms 900000 --json > wait-$NAME.json
EOF
