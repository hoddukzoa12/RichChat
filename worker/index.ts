import { error } from './http/error'
import { dispatch, type Route } from './http/router'
import { routes as attachmentsRoutes } from './routes/attachments'
import { routes as authRoutes } from './routes/auth'
import { routes as conversationDetailRoutes } from './routes/conversation-detail'
import { routes as conversationWriteRoutes } from './routes/conversation-write'
import { routes as conversationsRoutes } from './routes/conversations'
import { routes as customersRoutes } from './routes/customers'
import { routes as devRoutes } from './routes/dev'
import { routes as eventsRoutes } from './routes/events'
import { routes as healthRoutes } from './routes/health'
import { routes as hooksMoRoutes } from './routes/hooks-mo'
import { routes as hooksReportRoutes } from './routes/hooks-report'
import { routes as meRoutes } from './routes/me'
import { routes as messageAttachmentUploadRoutes } from './routes/message-attachments-upload'
import { routes as messagesSendRoutes } from './routes/messages-send'
import { routes as notesRoutes } from './routes/notes'
import { routes as officeRoutes } from './routes/office'
import { routes as readsRoutes } from './routes/reads'
import { routes as realtimeRoutes } from './routes/realtime'
import { routes as tasksRoutes } from './routes/tasks'
import { runScheduledTasks } from './scheduled'

export { OfficeHub } from './office-hub'

const routes: Route[] = [
  ...healthRoutes,
  ...meRoutes,
  ...devRoutes,
  ...authRoutes,
  ...attachmentsRoutes,
  ...conversationsRoutes,
  ...conversationDetailRoutes,
  ...conversationWriteRoutes,
  ...readsRoutes,
  ...customersRoutes,
  ...notesRoutes,
  ...tasksRoutes,
  ...officeRoutes,
  ...messageAttachmentUploadRoutes,
  ...messagesSendRoutes,
  ...hooksMoRoutes,
  ...hooksReportRoutes,
  ...eventsRoutes,
  ...realtimeRoutes,
]

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname

    if (!isApiPath(pathname)) {
      return env.ASSETS.fetch(request)
    }

    return (
      (await dispatch(request, env, routes, ctx)) ??
      error('NOT_FOUND', '요청한 API를 찾을 수 없습니다.')
    )
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runScheduledTasks(env, undefined, ctx)
  },
}
