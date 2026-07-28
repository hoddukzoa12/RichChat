export type RouteParams = Readonly<Record<string, string>>

export type RouteHandler = (
  request: Request,
  env: Env,
  params: RouteParams,
  ctx?: ExecutionContext,
) => Response | Promise<Response>

export interface Route {
  method: string
  path: string
  handler: RouteHandler
}

function matchPath(
  routePath: string,
  pathname: string,
): RouteParams | undefined {
  const routeSegments = routePath.split('/')
  const pathSegments = pathname.split('/')
  if (routeSegments.length !== pathSegments.length) return undefined

  const params: Record<string, string> = {}
  for (const [index, routeSegment] of routeSegments.entries()) {
    const pathSegment = pathSegments[index]

    if (!routeSegment.startsWith(':')) {
      if (routeSegment !== pathSegment) return undefined
      continue
    }

    if (pathSegment === '') return undefined

    try {
      params[routeSegment.slice(1)] = decodeURIComponent(pathSegment)
    } catch {
      return undefined
    }
  }

  return params
}

export async function dispatch(
  request: Request,
  env: Env,
  routes: Route[],
  ctx?: ExecutionContext,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  const methodRoutes = routes.filter(
    (candidate) => candidate.method === request.method,
  )
  const exactRoute = methodRoutes.find(
    (candidate) => candidate.path === pathname,
  )
  if (exactRoute) return exactRoute.handler(request, env, {}, ctx)

  for (const route of methodRoutes) {
    const params = matchPath(route.path, pathname)
    if (params) return route.handler(request, env, params, ctx)
  }

  return undefined
}
