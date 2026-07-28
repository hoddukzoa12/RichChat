import type { TaskKind } from '../domain'

export interface Task {
  id: string
  name: string
  sub: string
  kind: TaskKind
  sortOrder: number
  createdById: string
  createdAt: number
  updatedAt: number
}

export interface CreateTaskRequest {
  name: string
  sub?: string
  kind: TaskKind
  sortOrder?: number
}

export interface UpdateTaskRequest {
  name?: string
  sub?: string
  kind?: TaskKind
  sortOrder?: number
}

export interface TaskResponse {
  task: Task
}
