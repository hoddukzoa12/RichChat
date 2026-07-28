import { useEffect, useRef, type ReactNode } from 'react'
import type { Channel, Status } from '../types'
import { avatarTone, CHANNEL_BADGE, STATUS_BADGE } from '../theme'

export function Avatar({
  initial,
  className = 'w-8 h-8 text-xs',
  tone,
}: {
  initial: string
  className?: string
  tone?: string
}) {
  return (
    <span
      className={`flex-none rounded-full flex items-center justify-center font-bold ${
        tone ?? avatarTone(initial)
      } ${className}`}
    >
      {initial}
    </span>
  )
}

export function StatusBadge({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      className={`text-[11.5px] font-semibold rounded-[5px] px-[7px] py-[1.5px] ${STATUS_BADGE[status]} ${className}`}
    >
      {status}
    </span>
  )
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span
      className={`text-[11px] font-bold rounded-[5px] px-[6px] py-[1.5px] ${CHANNEL_BADGE[channel]}`}
    >
      {channel}
    </span>
  )
}

export function Toggle({ on, size = 'sm' }: { on: boolean; size?: 'sm' | 'lg' }) {
  const track = size === 'lg' ? 'w-[46px] h-[27px]' : 'w-[42px] h-6'
  const knob = size === 'lg' ? 'w-[21px] h-[21px]' : 'w-[18px] h-[18px]'
  return (
    <span
      className={`ml-auto flex-none rounded-full p-[3px] flex ${track} ${
        on ? 'justify-end bg-brand' : 'justify-start bg-line-soft'
      }`}
    >
      <span className={`${knob} rounded-full bg-white shadow-[0_1px_2px_rgba(16,24,40,.2)]`} />
    </span>
  )
}

export function ToggleRow({
  name,
  sub,
  on,
  onFlip,
  size = 'sm',
}: {
  name: string
  sub: string
  on: boolean
  onFlip: () => void
  size?: 'sm' | 'lg'
}) {
  return (
    <button
      type="button"
      onClick={onFlip}
      className="flex items-center gap-3 py-[11px] px-0.5 text-left w-full"
    >
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold">{name}</span>
        <span className="block text-[12.5px] text-ink-400">{sub}</span>
      </span>
      <Toggle on={on} size={size} />
    </button>
  )
}

/**
 * Absolutely-positioned dropdown that closes on outside click or Escape.
 * The trigger must be inside the same `relative` wrapper.
 */
export function Popover({
  open,
  onClose,
  className = '',
  children,
}: {
  open: boolean
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = ref.current
      if (el && !el.contains(e.target as Node) && !el.parentElement?.contains(e.target as Node)) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      className={`absolute z-30 bg-white border border-line rounded-[10px] shadow-[0_8px_24px_rgba(16,24,40,.14)] p-[5px] ${className}`}
    >
      {children}
    </div>
  )
}

export function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-[7px] text-[13.5px] w-full text-left ${
        active ? 'font-bold bg-fill' : 'font-medium hover:bg-fill/60'
      }`}
    >
      {children}
    </button>
  )
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`bg-white border border-line rounded-xl shadow-[0_1px_2px_rgba(16,24,40,.04)] ${className}`}
    >
      {children}
    </div>
  )
}
