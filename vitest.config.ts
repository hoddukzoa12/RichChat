import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config'

// 호환 풀의 내장 workerd가 설정 날짜보다 오래되어 테스트에서 날짜 fallback 경고가 발생한다.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations')

  return {
    test: {
      setupFiles: ['./tests/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: {
            configPath: './wrangler.jsonc',
          },
          miniflare: {
            assets: {
              directory: '.',
            },
            bindings: {
              DEV_LOGIN_ENABLED: 'true',
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  }
})
