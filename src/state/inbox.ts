import type {
  AiChatMessage,
  CardTab,
  Channel,
  ChannelFilter,
  Conversation,
  EditDraft,
  MobileView,
  OpenMenu,
  Page,
  Profile,
  Scope,
  Status,
  StatusFilter,
  TaskDraft,
  TeamMember,
  Toast,
} from '../types'
import { CONVERSATIONS, ME, PROFILE, TEAM } from '../data/seed'
import { DESKTOP_MIN } from '../../shared/breakpoints'

export interface NotifySettings {
  newChat: boolean
  mineOnly: boolean
  sound: boolean
}

export interface AiSettings {
  summary: boolean
  autofill: boolean
  draft: boolean
}

export interface OfficeSettings {
  aiOn: boolean
  docRead: boolean
  exportLog: boolean
}

export interface InboxState {
  convs: Conversation[]
  selected: number

  page: Page
  tab: CardTab
  cardOpen: boolean
  mobileView: MobileView

  query: string
  filter: StatusFilter
  scope: Scope
  chan: ChannelFilter
  archivedView: boolean
  menu: OpenMenu

  draft: string

  editDraft: EditDraft | null
  taskEdit: number | null
  addingTask: boolean
  taskDraft: TaskDraft
  noteEdit: number | null
  addingNote: boolean
  noteDraft: string

  profile: Profile
  notify: NotifySettings
  ai: AiSettings
  office: OfficeSettings
  isAdmin: boolean

  team: TeamMember[]
  inviteOpen: boolean
  inviteEmail: string
  inviteRole: string

  aiChats: Record<number, AiChatMessage[]>
  aiDraft: string
  aiLoading: boolean

  toast: Toast | null
}

export const initialState: InboxState = {
  convs: CONVERSATIONS,
  selected: 1,

  page: 'chat',
  tab: 'info',
  // 고객 카드는 desktop에서 대화 옆에 놓이고 그보다 좁으면 오버레이되므로,
  // 오버레이 구간에서는 닫힌 상태로 시작한다.
  cardOpen: typeof window === 'undefined' || window.innerWidth >= DESKTOP_MIN,
  mobileView: 'list',

  query: '',
  filter: '전체',
  scope: 'all',
  chan: 'all',
  archivedView: false,
  menu: null,

  draft: '',

  editDraft: null,
  taskEdit: null,
  addingTask: false,
  taskDraft: { name: '', sub: '', kind: 'idle' },
  noteEdit: null,
  addingNote: false,
  noteDraft: '',

  profile: PROFILE,
  notify: { newChat: true, mineOnly: false, sound: true },
  ai: { summary: true, autofill: true, draft: false },
  office: { aiOn: true, docRead: true, exportLog: false },
  isAdmin: true,

  team: TEAM,
  inviteOpen: false,
  inviteEmail: '',
  inviteRole: '상담 담당',

  aiChats: {},
  aiDraft: '',
  aiLoading: false,

  toast: null,
}

export type Action =
  | { type: 'select'; id: number }
  | { type: 'setPage'; page: Page }
  | { type: 'setTab'; tab: CardTab }
  | { type: 'toggleCard' }
  | { type: 'setMobileView'; view: MobileView }
  | { type: 'setQuery'; value: string }
  | { type: 'setFilter'; value: StatusFilter }
  | { type: 'setScope'; value: Scope }
  | { type: 'setChan'; value: ChannelFilter }
  | { type: 'setMenu'; value: OpenMenu }
  | { type: 'toggleArchivedView' }
  | { type: 'setStatus'; value: Status }
  | { type: 'toggleAssignee'; name: string }
  | { type: 'clearAssignees' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'setDraft'; value: string }
  | { type: 'send'; now: number }
  | { type: 'draftReply' }
  | { type: 'toggleTodo'; index: number }
  | { type: 'linkFolder' }
  | { type: 'unlinkFolder' }
  | { type: 'startEdit' }
  | { type: 'cancelEdit' }
  | { type: 'saveEdit' }
  | { type: 'setEditName'; value: string }
  | { type: 'setEditOrg'; value: string }
  | { type: 'setEditField'; index: number; value: string }
  | { type: 'addTask' }
  | { type: 'editTask'; index: number }
  | { type: 'cancelTask' }
  | { type: 'saveTask' }
  | { type: 'removeTask'; index: number }
  | { type: 'setTaskDraft'; patch: Partial<TaskDraft> }
  | { type: 'addNote' }
  | { type: 'editNote'; index: number }
  | { type: 'cancelNote' }
  | { type: 'saveNote'; now: number }
  | { type: 'removeNote'; index: number }
  | { type: 'setNoteDraft'; value: string }
  | { type: 'setProfile'; key: keyof Profile; value: string }
  | { type: 'toggleNotify'; key: keyof NotifySettings }
  | { type: 'toggleAi'; key: keyof AiSettings }
  | { type: 'toggleOffice'; key: keyof OfficeSettings }
  | { type: 'openInvite' }
  | { type: 'closeInvite' }
  | { type: 'setInviteEmail'; value: string }
  | { type: 'setInviteRole'; value: string }
  | { type: 'sendInvite' }
  | { type: 'setAiDraft'; value: string }
  | { type: 'askAi'; question: string }
  | { type: 'aiReply'; id: number; text: string }
  | { type: 'toastArrive'; toast: Toast }
  | { type: 'openToast' }
  | { type: 'dismissToast' }

export function currentConv(state: InboxState): Conversation {
  return state.convs.find((c) => c.id === state.selected) ?? state.convs[0]
}

/** Applies `fn` to the selected conversation only. */
function patch(
  state: InboxState,
  fn: (c: Conversation) => Partial<Conversation>,
): Conversation[] {
  return state.convs.map((c) => (c.id === state.selected ? { ...c, ...fn(c) } : c))
}

function clockLabel(now: Date): string {
  const h = now.getHours()
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`
}

function outboundStamp(channel: Channel, now: Date): string {
  return `${channel === '카톡' ? '채널톡' : 'SMS'} · ${clockLabel(now)}`
}

function noteStamp(now: Date): string {
  return `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`
}

export function reducer(state: InboxState, action: Action): InboxState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        selected: action.id,
        menu: null,
        draft: '',
        mobileView: 'chat',
        editDraft: null,
        taskEdit: null,
        addingTask: false,
        noteEdit: null,
        addingNote: false,
        convs: state.convs.map((c) => (c.id === action.id ? { ...c, unread: 0 } : c)),
      }

    case 'setPage':
      return { ...state, page: action.page, menu: null }

    case 'setTab':
      return { ...state, tab: action.tab }

    case 'toggleCard':
      return { ...state, cardOpen: !state.cardOpen }

    case 'setMobileView':
      return {
        ...state,
        mobileView: action.view,
        cardOpen: action.view === 'list' ? false : state.cardOpen,
      }

    case 'setQuery':
      return { ...state, query: action.value }

    case 'setFilter':
      return { ...state, filter: action.value }

    case 'setScope':
      return { ...state, scope: action.value, menu: null }

    case 'setChan':
      return { ...state, chan: action.value, menu: null }

    case 'setMenu':
      return { ...state, menu: action.value }

    case 'toggleArchivedView': {
      const next = !state.archivedView
      const first = state.convs.find((c) => c.archived === next)
      return {
        ...state,
        archivedView: next,
        menu: null,
        selected: first ? first.id : state.selected,
      }
    }

    case 'setStatus':
      return { ...state, menu: null, convs: patch(state, () => ({ status: action.value })) }

    case 'toggleAssignee':
      return {
        ...state,
        convs: patch(state, (c) => ({
          assignees: c.assignees.includes(action.name)
            ? c.assignees.filter((a) => a !== action.name)
            : [...c.assignees, action.name],
        })),
      }

    case 'clearAssignees':
      return { ...state, menu: null, convs: patch(state, () => ({ assignees: [] })) }

    case 'archive':
      return { ...state, convs: patch(state, () => ({ archived: true, status: '완료' })) }

    case 'unarchive':
      return { ...state, convs: patch(state, () => ({ archived: false, status: '처리중' })) }

    case 'setDraft':
      return { ...state, draft: action.value }

    case 'send': {
      const text = state.draft.trim()
      if (!text) return state
      const now = new Date(action.now)
      return {
        ...state,
        draft: '',
        convs: patch(state, (c) => ({
          messages: [...c.messages, { dir: 'out' as const, text, time: outboundStamp(c.channel, now) }],
          time: '방금',
          status: c.status === '미처리' ? '처리중' : c.status,
          assignees: c.assignees.length ? c.assignees : [ME],
        })),
      }
    }

    case 'draftReply':
      return { ...state, draft: currentConv(state).draft || '확인 후 회신드리겠습니다.' }

    case 'toggleTodo':
      return {
        ...state,
        convs: patch(state, (c) => ({
          todos: c.todos.map((t, i) => (i === action.index ? { ...t, done: !t.done } : t)),
        })),
      }

    case 'linkFolder':
      return {
        ...state,
        convs: patch(state, (c) => ({
          folderLinked: true,
          folderPath: c.folderPath || `/고객사/${c.name}`,
          docCount: c.docCount || 3,
        })),
      }

    case 'unlinkFolder':
      return { ...state, convs: patch(state, () => ({ folderLinked: false })) }

    case 'startEdit': {
      const c = currentConv(state)
      return {
        ...state,
        editDraft: { name: c.name, org: c.orgLine, fields: c.fields.map((f) => ({ ...f })) },
      }
    }

    case 'cancelEdit':
      return { ...state, editDraft: null }

    case 'saveEdit': {
      const d = state.editDraft
      if (!d) return state
      return {
        ...state,
        editDraft: null,
        convs: patch(state, () => ({
          name: d.name,
          orgLine: d.org,
          company: d.org.split(' · ')[0],
          fields: d.fields,
        })),
      }
    }

    case 'setEditName':
      return state.editDraft
        ? { ...state, editDraft: { ...state.editDraft, name: action.value } }
        : state

    case 'setEditOrg':
      return state.editDraft
        ? { ...state, editDraft: { ...state.editDraft, org: action.value } }
        : state

    case 'setEditField':
      return state.editDraft
        ? {
            ...state,
            editDraft: {
              ...state.editDraft,
              fields: state.editDraft.fields.map((f, i) =>
                i === action.index ? { ...f, v: action.value } : f,
              ),
            },
          }
        : state

    case 'addTask':
      return {
        ...state,
        addingTask: true,
        taskEdit: null,
        taskDraft: { name: '', sub: '', kind: 'idle' },
      }

    case 'editTask': {
      const t = currentConv(state).tasks[action.index]
      return {
        ...state,
        taskEdit: action.index,
        addingTask: false,
        taskDraft: { name: t.name, sub: t.sub, kind: t.kind },
      }
    }

    case 'cancelTask':
      return {
        ...state,
        addingTask: false,
        taskEdit: null,
        taskDraft: { name: '', sub: '', kind: 'idle' },
      }

    case 'saveTask': {
      const d = state.taskDraft
      const name = d.name.trim()
      const reset = {
        ...state,
        addingTask: false,
        taskEdit: null,
        taskDraft: { name: '', sub: '', kind: 'idle' as const },
      }
      if (!name) return reset
      const badge = d.kind === 'warn' ? '진행' : d.kind === 'done' ? '완료' : '대기'
      const row = { name, sub: d.sub, badge, kind: (d.kind === 'done' ? 'idle' : d.kind) as 'warn' | 'idle' }
      const idx = state.taskEdit
      return {
        ...reset,
        convs: patch(state, (c) => ({
          tasks: idx === null ? [...c.tasks, row] : c.tasks.map((t, i) => (i === idx ? row : t)),
        })),
      }
    }

    case 'removeTask':
      return {
        ...state,
        taskEdit: null,
        convs: patch(state, (c) => ({ tasks: c.tasks.filter((_, i) => i !== action.index) })),
      }

    case 'setTaskDraft':
      return { ...state, taskDraft: { ...state.taskDraft, ...action.patch } }

    case 'addNote':
      return { ...state, addingNote: true, noteEdit: null, noteDraft: '' }

    case 'editNote':
      return {
        ...state,
        noteEdit: action.index,
        addingNote: false,
        noteDraft: currentConv(state).notes[action.index].text,
      }

    case 'cancelNote':
      return { ...state, addingNote: false, noteEdit: null, noteDraft: '' }

    case 'saveNote': {
      const text = state.noteDraft.trim()
      const reset = { ...state, addingNote: false, noteEdit: null, noteDraft: '' }
      if (!text) return reset
      const stamp = noteStamp(new Date(action.now))
      const idx = state.noteEdit
      return {
        ...reset,
        convs: patch(state, (c) => ({
          notes:
            idx === null
              ? [...c.notes, { author: ME, time: stamp, text }]
              : c.notes.map((n, i) => (i === idx ? { ...n, text, time: `${stamp} 수정` } : n)),
        })),
      }
    }

    case 'removeNote':
      return {
        ...state,
        noteEdit: null,
        noteDraft: '',
        convs: patch(state, (c) => ({ notes: c.notes.filter((_, i) => i !== action.index) })),
      }

    case 'setNoteDraft':
      return { ...state, noteDraft: action.value }

    case 'setProfile':
      return { ...state, profile: { ...state.profile, [action.key]: action.value } }

    case 'toggleNotify':
      return { ...state, notify: { ...state.notify, [action.key]: !state.notify[action.key] } }

    case 'toggleAi':
      return { ...state, ai: { ...state.ai, [action.key]: !state.ai[action.key] } }

    case 'toggleOffice':
      return { ...state, office: { ...state.office, [action.key]: !state.office[action.key] } }

    case 'openInvite':
      return { ...state, inviteOpen: true, inviteEmail: '', inviteRole: '상담 담당' }

    case 'closeInvite':
      return { ...state, inviteOpen: false }

    case 'setInviteEmail':
      return { ...state, inviteEmail: action.value }

    case 'setInviteRole':
      return { ...state, inviteRole: action.value }

    case 'sendInvite': {
      const email = state.inviteEmail.trim()
      if (!email) return state
      const nick = email.split('@')[0]
      return {
        ...state,
        inviteOpen: false,
        team: [
          ...state.team,
          {
            name: nick,
            initial: nick[0].toUpperCase(),
            email,
            role: state.inviteRole,
            pending: true,
          },
        ],
      }
    }

    case 'setAiDraft':
      return { ...state, aiDraft: action.value }

    case 'askAi': {
      const q = action.question.trim()
      if (!q) return state
      const id = state.selected
      return {
        ...state,
        aiDraft: '',
        aiLoading: true,
        aiChats: { ...state.aiChats, [id]: [...(state.aiChats[id] ?? []), { role: 'user', text: q }] },
      }
    }

    case 'aiReply':
      return {
        ...state,
        aiLoading: false,
        aiChats: {
          ...state.aiChats,
          [action.id]: [...(state.aiChats[action.id] ?? []), { role: 'ai', text: action.text }],
        },
      }

    case 'toastArrive':
      return {
        ...state,
        toast: action.toast,
        convs: state.convs.map((c) =>
          c.id === action.toast.id
            ? {
                ...c,
                messages: [...c.messages, { dir: 'in' as const, text: action.toast.text, time: '방금' }],
                time: '방금',
                unread: c.unread + 1,
                status: c.status === '완료' ? '처리중' : c.status,
              }
            : c,
        ),
      }

    case 'openToast': {
      const t = state.toast
      if (!t) return state
      return {
        ...state,
        selected: t.id,
        toast: null,
        page: 'chat',
        mobileView: 'chat',
        convs: state.convs.map((c) => (c.id === t.id ? { ...c, unread: 0 } : c)),
      }
    }

    case 'dismissToast':
      return { ...state, toast: null }
  }
}
