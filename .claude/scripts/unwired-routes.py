#!/usr/bin/env python3
"""서버 라우트의 메서드가 프론트 엔드포인트 모듈에 구현됐는지 본다.

경로 문자열만 비교하면 안 된다. URL이 헬퍼 함수로 조립돼 메서드와 떨어져
있고, `/api/conversations`(목록 GET)와 `/api/conversations/:id`(PATCH)가
같은 접두어라 구분되지 않는다. 실제로 그래서 상태·보관 변경이 저장되지
않는 결함을 놓쳤다 — 운영에서 사용자가 발견했다.

대신 이 저장소의 규약을 쓴다: 모든 서버 호출은 `src/api/endpoints/*`를 거친다.
라우트를 자원 이름으로 그 모듈에 대응시키고, 메서드가 거기 있는지 본다.
"""
import pathlib, re, subprocess, sys

R = pathlib.Path(__file__).resolve().parents[2]
EP = R / "src" / "api" / "endpoints"
EXPECTED = {"GET /api/health", "GET /api/auth/callback"}   # 프론트가 안 불러도 정상
METHODS = ("GET", "POST", "PATCH", "PUT", "DELETE")

# 엔드포인트 모듈별로 등장하는 메서드를 모은다.
mods: dict[str, set[str]] = {}
for f in sorted(EP.glob("*.ts")):
    if ".test." in f.name:
        continue
    t = f.read_text(encoding="utf-8", errors="replace")
    found = {m for m in METHODS if f"'{m}'" in t or f'"{m}"' in t}
    if re.search(r"\bapiRequest\(|\bgetJson\(", t):
        found.add("GET")
    mods[f.stem] = found

# URL을 만들기만 하고 fetch 하지 않는 모듈 (예: <img src>용 경로 생성)
URL_ONLY = {"attachments"}

def candidates(path: str) -> list[str]:
    """자원 이름 후보 — 뒤쪽 리터럴 세그먼트부터. 단수/복수를 함께 본다."""
    segs = [s for s in path.strip("/").split("/")[1:] if not s.startswith(":")]
    out = []
    for seg in reversed(segs):
        out += [seg, seg + "s", seg.rstrip("s")]
    return out

routes = re.findall(r"\s+(\w+)\s+(/api/\S+)",
                    subprocess.run(["python3", str(R / ".claude/scripts/routes.py")],
                                   capture_output=True, text=True).stdout)

missing, unmapped = [], []
for meth, path in routes:
    if path.startswith("/api/hooks/") or f"{meth} {path}" in EXPECTED:
        continue
    hit = None
    for name in candidates(path):
        if name in mods:
            hit = name
            break
    if hit is None:
        unmapped.append(f"{meth} {path}")
    elif hit in URL_ONLY:
        pass          # 경로만 만들고 브라우저가 직접 가져간다
    elif meth not in mods[hit]:
        missing.append(f"{meth} {path}  (src/api/endpoints/{hit}.ts 에 {meth} 없음)")

for x in missing:
    print(f"  ★ {x}")
for x in unmapped:
    print(f"  ? {x}  (대응하는 엔드포인트 모듈을 못 찾음 — 수동 확인)")
print(f"\n메서드 누락 {len(missing)}건 · 미대응 {len(unmapped)}건")
if missing:
    print("배선이 빠진 것이다. 의도한 것이면 EXPECTED에 추가해라.")
    sys.exit(1)
print("✓ 누락 없음")
