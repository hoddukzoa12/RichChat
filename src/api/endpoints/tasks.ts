import type {
  CreateTaskRequest,
  TaskResponse,
  UpdateTaskRequest,
} from '../../../shared/wire/task'
import { apiRequest } from '../client'
import { apiJsonRequest } from './request'

function tasksPath(conversationId: string, taskId?: string): string {
  const collection = `/api/conversations/${encodeURIComponent(conversationId)}/tasks`
  return taskId === undefined
    ? collection
    : `${collection}/${encodeURIComponent(taskId)}`
}

export function createTask(
  conversationId: string,
  body: CreateTaskRequest,
  signal?: AbortSignal,
): Promise<TaskResponse> {
  return apiJsonRequest(tasksPath(conversationId), 'POST', body, signal)
}

export function updateTask(
  conversationId: string,
  taskId: string,
  body: UpdateTaskRequest,
  signal?: AbortSignal,
): Promise<TaskResponse> {
  return apiJsonRequest(
    tasksPath(conversationId, taskId),
    'PATCH',
    body,
    signal,
  )
}

export function deleteTask(
  conversationId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest(tasksPath(conversationId, taskId), {
    method: 'DELETE',
    signal,
  })
}
