# .claude — 프로젝트 스코프 에이전트 설정

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
