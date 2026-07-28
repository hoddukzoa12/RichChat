import type { Route } from '../http/router'
import { json } from '../http/respond'

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/health',
    handler: (_request, env) =>
      json({
        ok: true,
        env: env.LGU_ENV,
      }),
  },
]
