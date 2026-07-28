import { json } from './respond'

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CONFLICT_VERSION'
  | 'INTERNAL_ERROR'

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFLICT_VERSION: 409,
  INTERNAL_ERROR: 500,
}

export function error(code: ErrorCode, message: string): Response {
  return json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status: ERROR_STATUS[code],
    },
  )
}
