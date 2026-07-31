import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import styles from '../../index.css?inline'
import {
  reduceCustomerCardData,
  type CustomerCardDataState,
} from '../../state/customerCardModel'
import { InfoTabView } from './InfoTabView'
import {
  INFO_TAB_DETAIL,
  loadedInfoTabState,
} from './InfoTabView.testData'

function extractWidthRules(css: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter(([, selector, declarations]) => {
      return (
        selector.trim().startsWith('.') &&
        /(?:^|;)\s*width\s*:/.test(declarations)
      )
    })
    .map(([, selector, declarations]) => {
      return `${selector.trim()}{${declarations.trim()}}`
    })
    .join('\n')
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )
  if (!input) throw new Error(`${label} 입력칸을 찾지 못했습니다.`)
  return input
}

function inputByPlaceholder(
  container: HTMLElement,
  placeholder: string,
): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  )
  if (!input) throw new Error(`${placeholder} 입력칸을 찾지 못했습니다.`)
  return input
}

describe('Info tab field layout', () => {
  let container: HTMLDivElement
  let root: Root
  let style: HTMLStyleElement

  beforeAll(() => {
    style = document.createElement('style')
    // jsdom은 Tailwind v4의 cascade layer를 해석하지 못하므로, 실제 빌드 CSS에서
    // width 규칙만 같은 순서로 꺼내 계산 스타일 검증에 사용한다.
    style.textContent = extractWidthRules(styles)
    document.head.append(style)
  })

  afterAll(() => style.remove())

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(data: CustomerCardDataState) {
    act(() => {
      root.render(
        <InfoTabView
          conversationId={INFO_TAB_DETAIL.id}
          data={data}
          sessionUserId="user-1"
          dispatchData={vi.fn()}
          onReload={vi.fn()}
          onSaveTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onSaveNote={vi.fn()}
          onDeleteNote={vi.fn()}
        />,
      )
    })
  }

  it('keeps the field key fixed and the existing value visible', () => {
    const data = reduceCustomerCardData(loadedInfoTabState(), {
      type: 'startEdit',
      conversationId: INFO_TAB_DETAIL.id,
    })

    render(data)

    const keyInput = inputByLabel(container, '세무 정보 항목')
    const valueInput = inputByLabel(container, '사업자 유형 값')

    expect(keyInput.value).toBe('사업자 유형')
    expect(valueInput.value).toBe('법인')
    expect(getComputedStyle(keyInput).width).toBe('92px')
    expect(getComputedStyle(keyInput).width).not.toBe('100%')
  })

  it('keeps the other shared input frames full width', () => {
    const customerEdit = reduceCustomerCardData(loadedInfoTabState(), {
      type: 'startEdit',
      conversationId: INFO_TAB_DETAIL.id,
    })

    render(customerEdit)

    for (const input of [
      inputByPlaceholder(container, '고객명'),
      inputByLabel(container, '상호'),
      inputByLabel(container, '직함'),
    ]) {
      expect(getComputedStyle(input).width).toBe('100%')
    }

    const taskEdit = reduceCustomerCardData(loadedInfoTabState(), {
      type: 'editTask',
      conversationId: INFO_TAB_DETAIL.id,
      taskId: 'task-1',
    })

    render(taskEdit)

    for (const input of [
      inputByPlaceholder(container, '업무 이름'),
      inputByPlaceholder(container, '기한 · 메모'),
    ]) {
      expect(getComputedStyle(input).width).toBe('100%')
    }
  })
})
