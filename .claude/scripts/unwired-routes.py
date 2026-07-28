#!/usr/bin/env python3
"""서버 라우트 중 프론트가 부르지 않는 것을 찾는다.

부품은 만들어졌는데 배선이 없는 경우를 잡는다. 실제로 로그아웃 버튼이
onClick 없이 장식으로 남아 있었고, 읽음 커서는 아무도 호출하지 않아
conversation_reads가 0행이었다 — 테스트 395개가 전부 통과하는 상태였다.

정상적으로 프론트가 안 부르는 것들:
  GET  /api/health              스모크
  GET  /api/auth/callback       브라우저가 직접 이동 (fetch 아님)
  POST /api/hooks/lgu/*         외부 웹훅
"""
import pathlib, re, subprocess, sys

R = pathlib.Path(__file__).resolve().parents[2]
EXPECTED_UNWIRED = {
    "GET /api/health",
    "GET /api/auth/callback",
}

out = subprocess.run(["python3", str(R / ".claude/scripts/routes.py")],
                     capture_output=True, text=True).stdout
routes = re.findall(r"\s+(\w+)\s+(/api/\S+)", out)
src = subprocess.run(["grep", "-rn", "--include=*.ts", "--include=*.tsx", "/api/", str(R / "src")],
                     capture_output=True, text=True).stdout

missing = []
for meth, path in routes:
    if path.startswith("/api/hooks/"):
        continue
    if f"{meth} {path}" in EXPECTED_UNWIRED:
        continue
    base = re.sub(r"/:\w+", "", path)
    tail = base.rsplit("/", 1)[-1]
    if base not in src and f"/{tail}" not in src:
        missing.append(f"{meth} {path}")

for m in missing:
    print(f"  {m}")
print(f"\n프론트가 부르지 않는 라우트: {len(missing)}개")
if missing:
    print("의도한 것이면 EXPECTED_UNWIRED에 추가해라. 아니면 배선이 빠진 것이다.")
    sys.exit(1)
print("✓ 없음")
