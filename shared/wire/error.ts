export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT_VERSION'
  | 'NOT_INVITED'
  | 'MSG_TOO_LONG'
  | 'BAD_REQUEST'
  | 'GONE'

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT_VERSION: 409,
  NOT_INVITED: 403,
  MSG_TOO_LONG: 413,
  BAD_REQUEST: 400,
  GONE: 410,
}

export interface ApiError {
  error: {
    code: ErrorCode
    message: string
    detail?: unknown
  }
}
