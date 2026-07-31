# G18 — 외주 인수인계 운영 문서

`AGENTS.md`를 먼저 읽고 그 원칙을 따라라.

## 독자가 바뀌었다

이 시스템은 곧 **외부 유지보수 업체**에 넘어간다. 이 슬라이스의 산출물은
`docs/OPERATIONS.md` — **처음 보는 개발자가 시스템을 굴리는 데 필요한 전부**다.
코드를 고치는 규칙은 `AGENTS.md`가 정본이니 **복사하지 말고 참조해라.**
같은 사실을 두 문서에 쓰면 한쪽만 고쳐지는 사고가 난다 — SSOT는 문서에도
적용된다.

## `docs/OPERATIONS.md`에 담을 것

### 시스템 지도
Cloudflare Worker(단일, 정적+API) · D1 · R2 · Durable Object ↔
사무실 PC(Android SMS Gateway 서버, Docker, cloudflared 터널:
`sms.rich-group.kr`=업무폰 접속, `sms-api.rich-group.kr`=관리 API·Access 뒤)
↔ 업무폰들(capcom6 앱). LGU+ 관련 터널·코드는 휴면(GitHub 이슈 #1).
그림 하나(아스키·mermaid 아무거나)와 각 구성요소의 소유 계정 종류를 적어라
(값 말고 종류만 — Cloudflare 계정, 게이트웨이 관리 계정, 네이버웍스 콘솔 등).

### 배포 절차
`AGENTS.md` 첫 절이 정본이다 — 링크하고, **"빌드 없이 배포하면 지난 코드가
조용히 다시 올라간다"**는 함정만 다시 강조해라. 마이그레이션은 코드보다
먼저(`wrangler d1 migrations apply richchat --remote`), 적용 전후 행 수 확인.
시크릿은 `wrangler secret put`이고 **한 번 넣으면 다시 못 읽는다**는 사실.

### 정기 운영 절차 (화면 기준으로)
- 업무폰 추가: 사무소 설정 → 업무폰 → 등록 코드 발급 → 폰 앱에 코드 입력
  → 기기 감지 → 라벨·번호 등록 → **서명키 발급 → 폰 앱 Settings→Webhooks→
  Signing Key에 붙여넣기** (재발급하면 이전 키 즉시 무효)
- 게이트웨이 웹훅 등록(서버 교체·재설치 시): `sms:received`, `mms:received`,
  `mms:downloaded`, `sms:sent`, `sms:delivered`, `sms:failed` 여섯을
  같은 URL(`https://chat.rich-group.kr/api/hooks/sms-gateway`)로.
  관리 API `POST /api/3rdparty/v1/webhooks` (Basic 인증) 예시 명령 포함
- 직원 초대·역할, 발신 채널 관리

### 장애 진단 런북 — 이 문서의 핵심이다
실제 사고에서 나온 순서다 (`AGENTS.md` 도메인 제약 참조):
1. "수신이 안 된다" → `mo_failures` 조회 → `sms_gateway_mms_pending` 잔량
   → **요청 자체가 없으면 우리 문제가 아니다**: 발신자가 RCS인지(게이트웨이에
   안 보임), 폰 앱 켜져 있는지, 서명키 일치하는지 순서로
2. "발송이 실패로 뜬다" / "발송됨에서 안 넘어간다" → `발송됨`이 사실상 최종
   상태인 이유(수신자 통신사 리포트)
3. 로그인 문제 → 네이버웍스 OIDC 설정 위치
4. Cloudflare 로그 보는 법(`wrangler tail` 또는 대시보드) 한 단락
각 항목에 **실행 가능한 SQL/명령**을 붙여라.

### 데이터 모델 개요
한 단락 + `migrations/`가 정본이라고 가리켜라. 표 재생성 금지(CASCADE)와
한글 상태값=DB CHECK 동일 원칙만 짚어라.

## 설치 문서 편입

`$CLAUDE_JOB_DIR/tmp/SMS게이트웨이-설치-교정본.md`(조정자가 복사해 둠)를
`docs/게이트웨이-서버-설치.md`로 저장소에 넣어라. **내용은 사용자가 검증한
정본이니 고치지 말고**, 머리에 "2026-07 실제 설치로 검증된 문서" 한 줄과
현재 호스트명이 다른 부분이 있으면 **본문 수정 없이 상단에 차이 목록**만 달아라.

## 검증 — 문서도 실행이 검증이다

이 저장소는 설치 문서의 결함 10건을 실제 설치에서 발견한 적이 있다.
- OPERATIONS.md의 **모든 명령·SQL·경로·호스트를 실제로 실행하거나 저장소와
  대조**해라 (원격 D1을 건드리는 명령은 SELECT만 실행)
- 화면 절차는 실제 렌더로 경로가 존재하는지 확인해라
- `AGENTS.md`와 **중복 서술이 없는지** 훑어라 — 겹치면 참조로 바꿔라

## 건드리지 마라

`src/`, `worker/`, `shared/`, `migrations/`, 설정 파일 전부 — **문서 슬라이스다.**
`AGENTS.md`·`CLAUDE.md`·계획서 수정 금지. 고칠 것이 보이면 보고에 적어라.

## 수용 기준

1. `npm run check` 통과 (건드린 게 없으니 당연히 — 확인만)
2. `docs/OPERATIONS.md`가 위 절들을 갖추고, 명령이 전부 검증됐다
3. 설치 문서가 `docs/`에 있고 원문이 보존됐다
4. AGENTS.md와 사실 중복이 없다 (참조만)
5. 커밋하고 `origin/hoddukzoa12/g18-operations-doc`에 푸시한 뒤 해시를 보고해라.
   **배포하지 마라.**

## 막히면

내용이 확실치 않은 항목은 **추측으로 쓰지 말고** `ask`로 물어라. 틀린 운영
문서는 없는 것보다 나쁘다 — 이 저장소가 실제로 겪었다.
