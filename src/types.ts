import type {
  Channel,
  DeliveryStatus,
  Direction,
  Role,
  SendChannel,
  Status,
  TaskKind,
  UserStatus,
} from '../shared/domain'

export type {
  Channel,
  DeliveryStatus,
  Direction,
  Role,
  SendChannel,
  Status,
  TaskKind,
  UserStatus,
}

export type Page = 'chat' | 'office' | 'settings'
export type CardTab = 'info' | 'folder' | 'ai'
export type Scope = 'all' | 'mine' | 'none'
export type ChannelFilter = 'all' | Channel
export type StatusFilter = '전체' | Status
export type MobileView = 'list' | 'chat'
/** Which floating menu is open — only one at a time. */
export type OpenMenu = 'chan' | 'scope' | 'assign' | 'status' | null

export interface Message {
  dir: Direction
  text: string
  /** Free-form stamp, e.g. `오후 1:58` for inbound or `채널톡 · 오후 2:06` for outbound. */
  time: string
}

export interface Todo {
  text: string
  done: boolean
}

export interface Task {
  name: string
  sub: string
  badge: string
  kind: TaskKind
}

export interface Doc {
  name: string
  meta: string
}

export interface Note {
  author: string
  time: string
  text: string
}

export interface Field {
  k: string
  v: string
}

export interface Conversation {
  id: number
  name: string
  company: string
  orgLine: string
  initial: string
  channel: Channel
  phone: string
  time: string
  status: Status
  label: string
  assignees: string[]
  archived: boolean
  unread: number
  folderPath: string
  folderLinked: boolean
  docCount: number
  fields: Field[]
  summary: string
  todos: Todo[]
  tasks: Task[]
  docs: Doc[]
  notes: Note[]
  /** Canned reply the AI tab offers via "답장 초안 만들어 입력창에 넣기". */
  draft: string
  messages: Message[]
}

export interface TeamMember {
  name: string
  initial: string
  email: string
  role: string
  pending?: boolean
}

export interface Profile {
  name: string
  title: string
  email: string
  phone: string
  signature: string
}

export interface AiChatMessage {
  role: 'user' | 'ai'
  text: string
}

export interface Toast {
  id: number
  name: string
  channel: Channel
  initial: string
  text: string
}

export interface EditDraft {
  name: string
  org: string
  fields: Field[]
}

export interface TaskDraft {
  name: string
  sub: string
  kind: TaskKind
}
