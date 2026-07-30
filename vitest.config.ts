import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config'
import { TEST_SMS_GATEWAY_SIGNING_KEYS } from './tests/sms-gateway-fixtures'

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
              CF_ACCESS_CLIENT_ID: 'test-access-client-id',
              CF_ACCESS_CLIENT_SECRET: 'test-access-client-secret',
              DEV_LOGIN_ENABLED: 'true',
              LGU_ENV: 'local',
              LGU_AUTH_HOST: 'lgu-auth.test.invalid',
              LGU_SEND_HOST: 'lgu-send.test.invalid',
              LGU_CONTENT_HOST: 'lgu-content.test.invalid',
              LGU_MO_WEBHOOK_SECRET: 'test-mo-webhook-secret',
              LGU_REPORT_WEBHOOK_SECRET: 'test-report-webhook-secret',
              SMS_GATEWAY_API_URL:
                'https://sms-gateway.test.invalid/api/3rdparty/v1',
              SMS_GATEWAY_USERNAME: 'test-gateway-user',
              SMS_GATEWAY_PASSWORD: 'test-gateway-password',
              SMS_GATEWAY_SIGNING_KEYS: JSON.stringify(
                TEST_SMS_GATEWAY_SIGNING_KEYS,
              ),
              WORKS_CLIENT_ID: 'test-works-client-id',
              WORKS_CLIENT_SECRET: 'test-works-client-secret',
              WORKS_TENANT_ID: 'test-works-tenant-id',
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  }
})
