import { json } from './respond'

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'MSG_TOO_LONG'
  | 'MSG_EMOJI_UNSUPPORTED'
  | 'MSG_ATTACHMENTS_UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CONFLICT_VERSION'
  | 'GONE'
  | 'INTERNAL_ERROR'

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  MSG_TOO_LONG: 400,
  MSG_EMOJI_UNSUPPORTED: 400,
  MSG_ATTACHMENTS_UNSUPPORTED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFLICT_VERSION: 409,
  GONE: 410,
  INTERNAL_ERROR: 500,
}

export function error(
  code: ErrorCode,
  message: string,
  detail?: unknown,
): Response {
  return json(
    {
      error: {
        code,
        message,
        ...(detail === undefined ? {} : { detail }),
      },
    },
    {
      status: ERROR_STATUS[code],
    },
  )
}
