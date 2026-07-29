#!/usr/bin/env python3
"""닫힌 집합 상수를 **위치**로 꺼내는 곳을 찾는다.

`AGENTS.md` §2는 닫힌 집합의 분기를 `Record`로 쓰라고 요구한다. 그런데
`ROLES[0]`이나 `const [A, B] = ROLES` 같은 **위치 접근**은 그 규칙이 금지하는
형태가 아니라서 계속 새로 들어온다.

위치 접근은 유니온에 값이 늘거나 순서가 바뀔 때 **조용히 다른 값을 가리킨다.**
타입 체커가 못 잡는다. 이 저장소에서 세 번 났다:

  worker/routes/office.ts   const [ADMIN_ROLE, TAX_ACCOUNTANT_ROLE, COUNSELOR_ROLE] = ROLES
      → 역할이 셋에서 넷으로 늘 때 '상담 담당'을 통째로 누락했다
  shared/wire/office.ts     type AdministratorRole = (typeof ROLES)[0]
      → 같은 변경에서 초대 가능 역할이 잘못 계산됐다
  worker/routes/conversation-write.ts  const ACTIVE_USER_STATUS = USER_STATUSES[1]
      → 앞에 값이 하나 끼면 '비활성'을 가리켜 활성 직원 배정이 전부 막힌다

셋 다 `npm run check` 통과 상태였고 리뷰도 통과했다.

옳은 형태는 **이름으로 쓰고 `satisfies`로 지키는 것**이다:

    const ADMIN_ROLE = '관리자' satisfies Role

유니온에 없는 값이면 컴파일이 깨지므로 오타까지 잡힌다.

키 조회(`PERMISSION_ROLES['team:view']`)는 위치가 아니라 이름이므로 대상이 아니다.

사용:
    python3 .claude/scripts/positional-consts.py [기준]

기준을 주면 그 커밋의 파일을 검사한다 (`git show <기준>:<경로>`).
없으면 작업 트리를 검사한다.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCAN_DIRS = ("worker", "src", "shared")

# `export const NAME = [ ... ] as const` — 닫힌 집합의 정의
CLOSED_SET_RE = re.compile(
    r"(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[[^\]]*\]\s*as\s+const",
    re.S,
)

# 위치 접근 세 형태
INDEX_RE = re.compile(r"\b([A-Z][A-Z0-9_]*)\s*\[\s*(\d+)\s*\]")
TYPEOF_INDEX_RE = re.compile(r"\(\s*typeof\s+([A-Z][A-Z0-9_]*)\s*\)\s*\[\s*(\d+)\s*\]")
DESTRUCTURE_RE = re.compile(
    r"(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*([A-Z][A-Z0-9_]*)\b"
)


def ts_files(ref: str | None) -> list[str]:
    if ref:
        out = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", ref],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
        paths = out.splitlines()
    else:
        paths = [
            str(p.relative_to(ROOT))
            for p in ROOT.rglob("*.ts")
            if "node_modules" not in p.parts
        ]
    return [
        p for p in paths
        if p.endswith(".ts")
        and p.split("/", 1)[0] in SCAN_DIRS
        and not p.endswith(".d.ts")
    ]


def read(path: str, ref: str | None) -> str:
    if ref:
        r = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            cwd=ROOT, capture_output=True, text=True,
        )
        return r.stdout if r.returncode == 0 else ""
    return (ROOT / path).read_text(encoding="utf-8", errors="replace")


def main() -> int:
    ref = sys.argv[1] if len(sys.argv) > 1 else None
    paths = ts_files(ref)
    sources = {p: read(p, ref) for p in paths}

    # 1. 닫힌 집합의 이름을 모은다
    closed: set[str] = set()
    for text in sources.values():
        closed.update(CLOSED_SET_RE.findall(text))

    if not closed:
        print("닫힌 집합(`as const` 배열)을 하나도 못 찾았다.")
        print("스크립트가 고장났을 수 있으니 확인해라 — 0건 보고보다 위험하다.")
        return 2

    # 2. 위치 접근을 찾는다
    findings: list[tuple[str, int, str, str]] = []
    for path, text in sources.items():
        for lineno, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue

            for name, idx in TYPEOF_INDEX_RE.findall(line):
                if name in closed:
                    findings.append((path, lineno, f"(typeof {name})[{idx}]", stripped))

            for name, idx in INDEX_RE.findall(line):
                if name in closed:
                    # 위 typeof 형태와 중복 보고를 피한다
                    if f"typeof {name}" in line:
                        continue
                    findings.append((path, lineno, f"{name}[{idx}]", stripped))

            for names, name in DESTRUCTURE_RE.findall(line):
                if name in closed:
                    count = len([n for n in names.split(",") if n.strip()])
                    findings.append(
                        (path, lineno, f"const [...{count}개] = {name}", stripped)
                    )

    label = f"({ref})" if ref else "(작업 트리)"
    print(f"닫힌 집합 {len(closed)}개 검사 {label}")

    if not findings:
        print("\n✓ 위치 접근 없음")
        return 0

    print(f"\n위치로 꺼내는 곳 {len(findings)}건 — 이름 + `satisfies`로 바꿔라\n")
    for path, lineno, what, line in sorted(findings):
        print(f"  {path}:{lineno}")
        print(f"    {what}")
        print(f"    {line[:100]}")
        print()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
