import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('Worker', () => {
  it('returns health status', async () => {
    const response = await SELF.fetch('https://example.com/api/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      env: 'local',
    })
  })

  it('returns a JSON 404 for an unknown API', async () => {
    const response = await SELF.fetch('https://example.com/api/nope')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: '요청한 API를 찾을 수 없습니다.',
      },
    })
  })

  it('serves the SPA shell from the root', async () => {
    const response = await SELF.fetch('https://example.com/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toContain('<div id="root"></div>')
  })
})
