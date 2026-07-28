#!/usr/bin/env python3
"""테스트에서만 쓰이는 export 함수를 찾는다.

부품은 만들어졌는데 실제 경로에 배선이 안 된 경우를 잡는다.
B21이 OfficeHub·팬아웃을 다 만들고 `broadcastAfterCommit`을 아무도
호출하지 않은 채 병합됐다 — 테스트 378개가 전부 통과하는 상태였다.
"""
import pathlib, re, subprocess, sys

R = pathlib.Path(__file__).resolve().parents[2]
SEARCH = [R / d for d in ("worker", "shared", "src") if (R / d).exists()]
dead = []

for base in (R / "worker", R / "shared"):
    if not base.exists():
        continue
    for f in base.rglob("*.ts"):
        if f.name.endswith(".test.ts"):
            continue
        for name in re.findall(r"^export (?:async )?function (\w+)", f.read_text(encoding="utf-8"), re.M):
            out = subprocess.run(
                ["grep", "-rn", "--include=*.ts", "--include=*.tsx", r"\b" + name + r"\b", *map(str, SEARCH)],
                capture_output=True, text=True).stdout.splitlines()
            prod = [l for l in out if ".test.ts" not in l and ".test.tsx" not in l]
            real = [l for l in prod if not re.search(r"export (?:async )?function " + name + r"\b", l)]
            if not real:
                dead.append((str(f.relative_to(R)), name))

for f, n in dead:
    print(f"  {f}  →  {n}()")
print(f"\n테스트에서만 쓰이는 export: {len(dead)}개")
if dead:
    print("의도한 것이면 무시해도 되지만, 배선이 빠진 것인지 확인해라.")
    sys.exit(1)
print("✓ 없음")
