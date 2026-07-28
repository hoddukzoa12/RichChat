export interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>
  }
  LGU_ENV: string
}

export type RouteHandler = (
  request: Request,
  env: Env,
) => Response | Promise<Response>

export interface Route {
  method: string
  path: string
  handler: RouteHandler
}

export async function dispatch(
  request: Request,
  env: Env,
  routes: Route[],
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  const route = routes.find(
    (candidate) =>
      candidate.method === request.method && candidate.path === pathname,
  )

  return route?.handler(request, env)
}
