import { describe, expect, it, vi } from 'vitest'
import { dispatch, type Route, type RouteParams } from './router'

const env = {} as Env

describe('HTTP router', () => {
  it('prefers an exact route over a parameter route', async () => {
    const parameterHandler = vi.fn(() => new Response('parameter'))
    const exactHandler = vi.fn(() => new Response('exact'))
    const routes: Route[] = [
      {
        method: 'GET',
        path: '/api/items/:id',
        handler: parameterHandler,
      },
      {
        method: 'GET',
        path: '/api/items/new',
        handler: exactHandler,
      },
    ]

    const response = await dispatch(
      new Request('https://example.com/api/items/new'),
      env,
      routes,
    )

    await expect(response?.text()).resolves.toBe('exact')
    expect(exactHandler).toHaveBeenCalledOnce()
    expect(parameterHandler).not.toHaveBeenCalled()
  })

  it('decodes parameter values before invoking the handler', async () => {
    const handler = vi.fn(
      (_request: Request, _env: Env, params: RouteParams) =>
        Response.json(params),
    )
    const routes: Route[] = [
      {
        method: 'GET',
        path: '/api/attachments/:id',
        handler,
      },
    ]

    const response = await dispatch(
      new Request(
        'https://example.com/api/attachments/%EC%82%AC%EC%97%85%EC%9E%90%2F%EB%93%B1%EB%A1%9D%EC%A6%9D',
      ),
      env,
      routes,
    )

    await expect(response?.json()).resolves.toEqual({
      id: '사업자/등록증',
    })
  })

  it('does not match a parameter across missing path segments', async () => {
    const handler = vi.fn(() => new Response())
    const routes: Route[] = [
      {
        method: 'GET',
        path: '/api/attachments/:id',
        handler,
      },
    ]

    const response = await dispatch(
      new Request('https://example.com/api/attachments'),
      env,
      routes,
    )

    expect(response).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})
