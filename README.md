<div align="center">

<img src="public/logo.jpg" alt="RichChat 로고" width="180" />

# RichChat

**리치챗 — 세무법인 리치 상담 인박스**

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)

</div>

---

**세무법인 리치의 고객 문의 관리 도구입니다. 카카오톡·문자로 들어오는 고객 문의를 하나의 인박스에서 응대하고, 고객별 세무 정보·업무·문서를 함께 봅니다.**

## 주요 기능

<table>
  <tr>
    <td><b>📥 통합 인박스</b></td>
    <td>카카오톡·문자(SMS/LMS/MMS) 고객 문의를 하나의 화면에서 관리</td>
  </tr>
  <tr>
    <td><b>⚡ 실시간 알림</b></td>
    <td>Durable Objects WebSocket으로 새 문의 즉시 수신</td>
  </tr>
  <tr>
    <td><b>📱 업무폰 SMS 게이트웨이</b></td>
    <td>Android 기기를 통한 직접 문자 송수신</td>
  </tr>
  <tr>
    <td><b>👤 고객 관리</b></td>
    <td>세무 업무·메모·첨부파일을 고객 대화와 함께 조회</td>
  </tr>
  <tr>
    <td><b>🔐 네이버웍스 SSO</b></td>
    <td>네이버웍스 OIDC로 사무실 직원 인증</td>
  </tr>
</table>

## 빠른 시작

```sh
npm install
npm run dev      # 개발 서버 :5173
```

```sh
npm run build    # tsc -b && vite build
npm run check    # 타입체크 + 테스트 — 완료 판정은 이것
```

## 프로젝트 구조

```
src/              # React 프론트엔드 (브라우저 전용)
  api/            # API 클라이언트 엔드포인트
  components/     # UI 컴포넌트
  data/           # 시드·상수 데이터
  hooks/          # React 훅
  state/          # 상태 관리 (리듀서, 셀렉터)
  theme.ts        # 상태→스타일 매핑
shared/           # 프론트와 워커가 함께 쓰는 도메인 타입·순수 함수
  wire/           # 와이어 포맷 타입
worker/           # Cloudflare Worker 백엔드 (서버 전용)
  routes/         # HTTP 라우트 핸들러
  db/             # D1 데이터베이스 접근
  gateway/        # 외부 API 어댑터 (SMS Gateway)
  works/          # 네이버웍스 OIDC 연동
  realtime/       # Durable Objects, WebSocket
migrations/       # D1 스키마 마이그레이션 (스키마의 유일한 정의)
design/           # UI 디자인 원본 (.dc.html)
```

## 배포

단일 Worker가 정적 자산과 API를 함께 서빙합니다. **배포는 반드시 빌드 뒤에 합니다** — `wrangler deploy`는 빌드가 생성한 `dist/richchat/wrangler.json`을 읽으므로, 빌드 없이 배포하면 지난 빌드가 그대로 다시 올라갑니다.

```sh
npm run build && npx wrangler deploy
```

## 기술 스택

| 영역 | 기술 |
|---|---|
| 프론트엔드 | Vite + React 19 + TypeScript + Tailwind CSS v4 |
| 백엔드 | Cloudflare Workers (정적 자산 + API 단일 Worker) |
| 데이터베이스 | Cloudflare D1 (SQLite) |
| 실시간 | Durable Objects (WebSocket 푸시) |
| 메시징 | Android SMS Gateway |
| 인증 | 네이버웍스 OIDC |
| 테스트 | Vitest (`@cloudflare/vitest-pool-workers`) |
