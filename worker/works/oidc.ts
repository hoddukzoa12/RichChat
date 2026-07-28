const CACHE_TTL_MS = 60 * 60 * 1_000
const JWT_PARTS = 3
const RS256 = 'RS256'

export type OidcFetch = typeof fetch

export interface WorksOidcBindings {
  WORKS_CLIENT_ID: string
  WORKS_CLIENT_SECRET: string
  WORKS_ISSUER: string
  WORKS_TENANT_ID: string
}

export interface WorksConfiguration {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
}

export interface VerifiedIdToken {
  sub: string
  email: string
}

interface JwtHeader {
  alg: string
  kid: string
  typ: string
}

interface JwtClaims {
  iss: string
  sub: string
  aud: string | string[]
  nonce: string
  email: string
  exp: number
  iat: number
}

interface SigningJwk extends JsonWebKey {
  alg: string
  e: string
  kid: string
  kty: string
  n: string
  use: string
}

interface JwksDocument {
  keys: SigningJwk[]
}

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const discoveryCache = new Map<string, CacheEntry<WorksConfiguration>>()
const discoveryLoads = new Map<string, Promise<WorksConfiguration>>()
const jwksCache = new Map<string, CacheEntry<JwksDocument>>()
const jwksLoads = new Map<string, Promise<JwksDocument>>()

export class OidcValidationError extends Error {
  constructor() {
    super('OIDC 검증에 실패했습니다.')
    this.name = 'OidcValidationError'
  }
}

function validationError(): never {
  throw new OidcValidationError()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate === '') {
    return validationError()
  }

  return candidate
}

function secureUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return validationError()
  }

  if (url.protocol !== 'https:') return validationError()
  return value
}

function discoveryUrl(bindings: WorksOidcBindings): string {
  if (
    bindings.WORKS_CLIENT_ID === '' ||
    bindings.WORKS_CLIENT_SECRET === '' ||
    bindings.WORKS_TENANT_ID === ''
  ) {
    return validationError()
  }

  const base = new URL(secureUrl(bindings.WORKS_ISSUER))
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(
    bindings.WORKS_TENANT_ID,
  )}/.well-known/openid-configuration`
  base.search = ''
  base.hash = ''
  return base.toString()
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) return validationError()

  try {
    return await response.json()
  } catch {
    return validationError()
  }
}

async function fetchDiscovery(
  url: string,
  fetcher: OidcFetch,
): Promise<WorksConfiguration> {
  const document = await readJson(
    await fetcher(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    }),
  )
  if (!isObject(document)) return validationError()

  return {
    issuer: secureUrl(requiredString(document, 'issuer')),
    authorizationEndpoint: secureUrl(
      requiredString(document, 'authorization_endpoint'),
    ),
    tokenEndpoint: secureUrl(
      requiredString(document, 'token_endpoint'),
    ),
    jwksUri: secureUrl(requiredString(document, 'jwks_uri')),
  }
}

async function cachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  loads: Map<string, Promise<T>>,
  key: string,
  now: number,
  load: () => Promise<T>,
  force = false,
): Promise<T> {
  const cached = cache.get(key)
  if (!force && cached && cached.expiresAt > now) {
    return cached.value
  }

  const loading = loads.get(key)
  if (!force && loading) return loading

  const promise = load()
  loads.set(key, promise)
  try {
    const value = await promise
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
    return value
  } finally {
    if (loads.get(key) === promise) loads.delete(key)
  }
}

export async function getWorksConfiguration(
  bindings: WorksOidcBindings,
  fetcher: OidcFetch,
  now: number,
): Promise<WorksConfiguration> {
  const url = discoveryUrl(bindings)
  return cachedValue(
    discoveryCache,
    discoveryLoads,
    url,
    now,
    () => fetchDiscovery(url, fetcher),
  )
}

function isSigningJwk(value: unknown): value is SigningJwk {
  if (!isObject(value)) return false

  return (
    value.kty === 'RSA' &&
    value.use === 'sig' &&
    value.alg === RS256 &&
    typeof value.kid === 'string' &&
    value.kid !== '' &&
    typeof value.e === 'string' &&
    value.e !== '' &&
    typeof value.n === 'string' &&
    value.n !== ''
  )
}

async function fetchJwks(
  url: string,
  fetcher: OidcFetch,
): Promise<JwksDocument> {
  const document = await readJson(
    await fetcher(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    }),
  )
  if (!isObject(document) || !Array.isArray(document.keys)) {
    return validationError()
  }

  const keys = document.keys.filter(isSigningJwk)
  if (keys.length === 0) return validationError()
  return { keys }
}

async function getJwks(
  url: string,
  fetcher: OidcFetch,
  now: number,
  force = false,
): Promise<JwksDocument> {
  return cachedValue(
    jwksCache,
    jwksLoads,
    url,
    now,
    () => fetchJwks(url, fetcher),
    force,
  )
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return validationError()

  const padding = (4 - (value.length % 4)) % 4
  const base64 =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat(padding)

  let decoded: string
  try {
    decoded = atob(base64)
  } catch {
    return validationError()
  }

  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(value)),
    )
    if (!isObject(parsed)) return validationError()
    return parsed
  } catch {
    return validationError()
  }
}

function parseHeader(value: Record<string, unknown>): JwtHeader {
  const header = {
    alg: requiredString(value, 'alg'),
    kid: requiredString(value, 'kid'),
    typ: requiredString(value, 'typ'),
  }
  if (header.alg !== RS256 || header.typ !== 'JWT') {
    return validationError()
  }

  return header
}

function parseClaims(value: Record<string, unknown>): JwtClaims {
  const aud = value.aud
  if (
    typeof aud !== 'string' &&
    (!Array.isArray(aud) ||
      aud.length === 0 ||
      !aud.every((candidate) => typeof candidate === 'string'))
  ) {
    return validationError()
  }

  const exp = value.exp
  const iat = value.iat
  if (
    typeof exp !== 'number' ||
    !Number.isInteger(exp) ||
    typeof iat !== 'number' ||
    !Number.isInteger(iat)
  ) {
    return validationError()
  }

  return {
    iss: requiredString(value, 'iss'),
    sub: requiredString(value, 'sub'),
    aud,
    nonce: requiredString(value, 'nonce'),
    email: requiredString(value, 'email'),
    exp,
    iat,
  }
}

async function verifySignature(
  signingInput: string,
  signature: Uint8Array<ArrayBuffer>,
  key: SigningJwk,
): Promise<boolean> {
  let publicKey: CryptoKey
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify'],
    )
  } catch {
    return false
  }

  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    new TextEncoder().encode(signingInput),
  )
}

function audienceIncludes(
  audience: string | string[],
  clientId: string,
): boolean {
  return typeof audience === 'string'
    ? audience === clientId
    : audience.includes(clientId)
}

export async function verifyIdToken(
  token: string,
  expected: {
    clientId: string
    configuration: WorksConfiguration
    nonce: string
  },
  fetcher: OidcFetch,
  now: number,
): Promise<VerifiedIdToken> {
  const parts = token.split('.')
  if (parts.length !== JWT_PARTS) return validationError()

  const [encodedHeader, encodedClaims, encodedSignature] = parts
  const header = parseHeader(decodeJson(encodedHeader))
  const claimsValue = decodeJson(encodedClaims)
  const signature = decodeBase64Url(encodedSignature)
  const signingInput = `${encodedHeader}.${encodedClaims}`

  let jwks = await getJwks(
    expected.configuration.jwksUri,
    fetcher,
    now,
  )
  let key = jwks.keys.find((candidate) => candidate.kid === header.kid)
  let valid =
    key !== undefined &&
    (await verifySignature(signingInput, signature, key))

  if (!valid) {
    jwks = await getJwks(
      expected.configuration.jwksUri,
      fetcher,
      now,
      true,
    )
    key = jwks.keys.find((candidate) => candidate.kid === header.kid)
    valid =
      key !== undefined &&
      (await verifySignature(signingInput, signature, key))
  }

  if (!valid) return validationError()

  const claims = parseClaims(claimsValue)
  const nowSeconds = Math.floor(now / 1_000)
  if (
    claims.iss !== expected.configuration.issuer ||
    !audienceIncludes(claims.aud, expected.clientId) ||
    claims.nonce !== expected.nonce ||
    claims.iat > nowSeconds ||
    claims.exp <= nowSeconds
  ) {
    return validationError()
  }

  return {
    sub: claims.sub,
    email: claims.email,
  }
}

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  bindings: WorksOidcBindings,
  configuration: WorksConfiguration,
  fetcher: OidcFetch,
): Promise<string> {
  const body = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    client_id: bindings.WORKS_CLIENT_ID,
    client_secret: bindings.WORKS_CLIENT_SECRET,
    redirect_uri: redirectUri,
  })
  const document = await readJson(
    await fetcher(configuration.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    }),
  )
  if (!isObject(document)) return validationError()

  return requiredString(document, 'id_token')
}
