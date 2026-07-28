#!/usr/bin/env python3
"""등록된 라우트를 뽑아 메서드+경로 중복을 찾는다.

문자열 리터럴뿐 아니라 같은 파일의 `const X = '...'` 상수도 해석한다.
grep만으로는 상수 경로를 놓쳐 "중복 없음"이라는 잘못된 안심을 준다.
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[2] / "worker" / "routes"
seen: dict[tuple[str, str], list[str]] = {}

for f in sorted(root.glob("*.ts")):
    if f.name.endswith(".test.ts"):
        continue
    txt = f.read_text(encoding="utf-8")
    consts = dict(re.findall(r"const\s+(\w+)\s*=\s*'([^']+)'", txt))
    for meth, raw in re.findall(r"method:\s*'(\w+)',\s*\n\s*path:\s*([^,\n]+),", txt):
        raw = raw.strip()
        path = raw[1:-1] if raw.startswith("'") else consts.get(raw)
        if path is None:
            print(f"⚠ 해석 실패: {f.name} {meth} {raw}", file=sys.stderr)
            continue
        seen.setdefault((meth, path), []).append(f.name)

dups = {k: v for k, v in seen.items() if len(v) > 1}
for (meth, path), files in sorted(seen.items(), key=lambda x: x[0][1]):
    print(f"  {meth:6} {path:46} {files[0]}")
print(f"\n라우트 {len(seen)}개")
if dups:
    print("✗ 같은 메서드+경로를 둘 이상이 등록한다:")
    for (meth, path), files in dups.items():
        print(f"   {meth} {path} ← {files}")
    sys.exit(1)
print("✓ 메서드+경로 중복 없음")
