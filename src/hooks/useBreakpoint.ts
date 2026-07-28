import { useEffect, useState } from 'react'
import { DESKTOP_MIN, MOBILE_MAX } from '../../shared/breakpoints'

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

function read(width: number): Breakpoint {
  if (width < MOBILE_MAX) return 'mobile'
  if (width < DESKTOP_MIN) return 'tablet'
  return 'desktop'
}

/** 공용 브레이크포인트 정의에 따라 mobile/tablet/desktop 구간을 반환한다. */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() =>
    typeof window === 'undefined' ? 'desktop' : read(window.innerWidth),
  )

  useEffect(() => {
    const onResize = () => setBp(read(window.innerWidth))
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return bp
}
