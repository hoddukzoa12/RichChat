import { describe, expect, it } from 'vitest'
import {
  getWorksConfiguration,
  type OidcFetch,
  type WorksOidcBindings,
} from './oidc'

const CONFIGURED_ISSUER = 'https://auth.worksmobile.com'

function bindings(tenantId: string): WorksOidcBindings {
  return {
    WORKS_CLIENT_ID: 'test-works-client-id',
    WORKS_CLIENT_SECRET: 'test-works-client-secret',
    WORKS_ISSUER: CONFIGURED_ISSUER,
    WORKS_TENANT_ID: tenantId,
  }
}

function discovery(document: Record<string, unknown>): OidcFetch {
  return () => Promise.resolve(Response.json(document))
}

describe('NAVER WORKS OIDC discovery', () => {
  it('rejects an attacker-controlled issuer', async () => {
    const configuration = getWorksConfiguration(
      bindings('test-attacker-issuer'),
      discovery({
        issuer: 'https://evil.example',
        authorization_endpoint: 'https://evil.example/authorize',
        token_endpoint: 'https://evil.example/token',
        jwks_uri: 'https://evil.example/jwks',
      }),
      Date.now(),
    )

    await expect(configuration).rejects.toThrow(
      'OIDC 검증에 실패했습니다.',
    )
  })

  it.each([
    {
      field: 'authorization_endpoint',
      overrides: {
        authorization_endpoint: 'https://evil.example/authorize',
      },
    },
    {
      field: 'token_endpoint',
      overrides: {
        token_endpoint: 'https://evil.example/token',
      },
    },
    {
      field: 'jwks_uri',
      overrides: {
        jwks_uri: 'https://evil.example/jwks',
      },
    },
  ])('rejects a cross-origin $field', async ({ field, overrides }) => {
    const configuration = getWorksConfiguration(
      bindings(`test-cross-origin-${field}`),
      discovery({
        issuer: CONFIGURED_ISSUER,
        authorization_endpoint: `${CONFIGURED_ISSUER}/authorize`,
        token_endpoint: `${CONFIGURED_ISSUER}/token`,
        jwks_uri: `${CONFIGURED_ISSUER}/jwks`,
        ...overrides,
      }),
      Date.now(),
    )

    await expect(configuration).rejects.toThrow(
      'OIDC 검증에 실패했습니다.',
    )
  })
})
