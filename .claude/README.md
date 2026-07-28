# .claude — 프로젝트 스코프 에이전트 설정

## 슬라이스 프롬프트와 디스패치 스크립트

백엔드 구현은 슬라이스 단위로 쪼개 각각 별도 워크트리의 Codex에게 맡긴다.
슬라이스 정의의 **정본은 계획서**이고, 여기 프롬프트는 그것을 실행 가능한
형태로 옮긴 것이다.

```
prompts/
  prompt-header.md       모든 구현 프롬프트 앞에 붙는다 ({{SLICE}} 치환)
  prompt-footer.md       모든 구현 프롬프트 뒤에 붙는다 (커밋·ask·금지 경로)
  review-footer.md       모든 리뷰 프롬프트 뒤에 붙는다
  prompt-<슬라이스>.md   슬라이스별 본문
  review-<슬라이스>.md   리뷰 지시
scripts/
  dispatch.sh            워크트리 생성 → 프롬프트 조립 → orchestration 디스패치
  review.sh              별도 워크트리에 독립 리뷰어 디스패치
```

```sh
.claude/scripts/dispatch.sh b3-db-helpers .claude/prompts/prompt-B3.md
.claude/scripts/review.sh   b2-schema     .claude/prompts/review-B2.md
```

헤더·꼬리말을 자동으로 붙이는 이유는 **손으로 쓰다 두 번 빠뜨렸기 때문**이다
(커밋 지시 누락, 프롬프트 내 모순). 규칙을 기억하는 것보다 스크립트가 강제하는
쪽이 확실하다.


## Cloudflare 스킬 (gitignore 대상 — 각자 설치)

`.claude/skills/`와 `.claude/commands/cloudflare/`는 [cloudflare/skills](https://github.com/cloudflare/skills)
벤더 사본이라 커밋하지 않는다. 클론 후 아래로 설치한다.

```sh
git clone --depth 1 https://github.com/cloudflare/skills.git /tmp/cf-skills
mkdir -p .claude/skills .claude/commands/cloudflare
cp -R /tmp/cf-skills/skills/. .claude/skills/
cp /tmp/cf-skills/commands/*.md .claude/commands/cloudflare/
```

설치되는 스킬: `cloudflare`, `workers-best-practices`, `durable-objects`, `wrangler`,
`agents-sdk`, `sandbox-sdk`, `cloudflare-email-service`, `web-perf`, `turnstile-spin`,
`cloudflare-one`, `cloudflare-one-migrations`
커맨드: `/cloudflare:build-agent`, `/cloudflare:build-mcp`

현재 설치본의 upstream 커밋은 `.claude/skills/.UPSTREAM`에 남긴다.

사용자 전역(`~/.claude/skills/`)에 깔고 싶으면 플러그인 마켓플레이스가 더 편하다.

```
/plugin marketplace add cloudflare/skills
/plugin install cloudflare@cloudflare
```

## MCP 서버 (`.mcp.json` — 커밋 대상)

Cloudflare 원격 MCP 서버 5종을 프로젝트에 선언해 뒀다. 선언만으로는 아무것도 연결되지 않고,
Claude Code가 최초 사용 시 승인을 묻는다.

| 서버 | 용도 |
|---|---|
| `cloudflare-docs` | 최신 Cloudflare 문서 조회 (읽기) |
| `cloudflare-bindings` | Workers 바인딩(D1·R2·KV·DO·Queues) 구성 |
| `cloudflare-observability` | 로그·애널리틱스 조회 |
| `cloudflare-builds` | Workers 빌드 상태 조회 |
| `cloudflare-api` | 계정·존·설정 관리 — **쓰기 권한 있음, 주의** |
