import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationDetailResponse,
  UpdateCustomerResponse,
} from '../../../shared/wire'
import type { NoteResponse } from '../../../shared/wire/note'
import type { TaskResponse } from '../../../shared/wire/task'
import {
  createNote,
  createTask,
  deleteNote,
  deleteTask,
  getConversationDetail,
  updateCustomer,
  updateNote,
  updateTask,
} from '.'

afterEach(() => {
  vi.unstubAllGlobals()
})

function responseFor(path: string, init?: RequestInit): Response {
  if (init?.method === 'DELETE') return new Response(null, { status: 204 })

  if (path.startsWith('/api/customers/')) {
    return Response.json({
      customer: {
        id: 'customer-1',
        phoneE164: '+821012345678',
        name: '홍길동',
        company: '리치 · 세무',
        roleTitle: '대표',
        version: 2,
        updatedAt: 2,
        fields: [],
      },
    } satisfies UpdateCustomerResponse)
  }

  if (path.endsWith('/notes') || path.includes('/notes/')) {
    return Response.json({
      note: {
        id: 'note-1',
        authorId: 'user-1',
        authorName: '박상담',
        body: '확인했습니다.',
        createdAt: 1,
        updatedAt: 1,
      },
    } satisfies NoteResponse)
  }

  if (path.endsWith('/tasks') || path.includes('/tasks/')) {
    return Response.json({
      task: {
        id: 'task-1',
        name: '부가세 신고',
        sub: '기한 8/10',
        kind: 'done',
        sortOrder: 0,
        createdById: 'user-1',
        createdAt: 1,
        updatedAt: 1,
      },
    } satisfies TaskResponse)
  }

  return Response.json({
    conversation: {
      id: 'conversation-1',
      officeChannel: {
        id: 'office-channel-1',
        label: '업무폰 1',
        value: '01012345678',
      },
      status: '미처리',
      label: '',
      archived: false,
      version: 1,
      customer: {
        id: 'customer-1',
        name: '홍길동',
        company: '리치 · 세무',
        roleTitle: '대표',
        phoneE164: '+821012345678',
        version: 1,
        fields: [],
      },
      assignees: [],
      tasks: [],
      notes: [],
    },
  } satisfies ConversationDetailResponse)
}

function parsedBody(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined
  return init?.body === undefined ? undefined : JSON.parse(String(init.body))
}

describe('Customer card endpoints', () => {
  it('loads detail and patches editable customer fields without phone', async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) =>
      Promise.resolve(responseFor(path, init)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getConversationDetail('conversation/1')
    await updateCustomer('customer/1', {
      version: 1,
      name: '홍길동',
      company: '리치 · 세무',
      roleTitle: '대표',
      fieldChanges: {
        update: [{ id: 'field-1', value: '일반과세자' }],
        delete: ['field-2'],
      },
    })

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/conversations/conversation%2F1',
    )
    expect(fetchMock.mock.calls[1][0]).toBe('/api/customers/customer%2F1')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH' })
    expect(parsedBody(fetchMock.mock.calls[1])).toEqual({
      version: 1,
      name: '홍길동',
      company: '리치 · 세무',
      roleTitle: '대표',
      fieldChanges: {
        update: [{ id: 'field-1', value: '일반과세자' }],
        delete: ['field-2'],
      },
    })
    expect(JSON.stringify(parsedBody(fetchMock.mock.calls[1]))).not.toContain(
      'phone',
    )
  })

  it('uses id-based note item routes and keeps authors out of writes', async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) =>
      Promise.resolve(responseFor(path, init)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createNote('conversation/1', '새 메모')
    await updateNote('conversation/1', 'note/2', '수정 메모')
    await deleteNote('conversation/1', 'note/2')

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/conversations/conversation%2F1/notes',
      '/api/conversations/conversation%2F1/notes/note%2F2',
      '/api/conversations/conversation%2F1/notes/note%2F2',
    ])
    expect(parsedBody(fetchMock.mock.calls[0])).toEqual({ body: '새 메모' })
    expect(parsedBody(fetchMock.mock.calls[1])).toEqual({ body: '수정 메모' })
    expect(parsedBody(fetchMock.mock.calls[2])).toBeUndefined()
  })

  it('preserves every task kind across create and update requests', async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) =>
      Promise.resolve(responseFor(path, init)),
    )
    vi.stubGlobal('fetch', fetchMock)

    await createTask('conversation-1', {
      name: '부가세 신고',
      sub: '기한 8/10',
      kind: 'done',
    })
    const updated = await updateTask('conversation-1', 'task-1', {
      kind: 'done',
    })
    await deleteTask('conversation-1', 'task-1')

    expect(parsedBody(fetchMock.mock.calls[0])).toMatchObject({ kind: 'done' })
    expect(parsedBody(fetchMock.mock.calls[1])).toEqual({ kind: 'done' })
    expect(updated.task.kind).toBe('done')
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE' })
  })
})
