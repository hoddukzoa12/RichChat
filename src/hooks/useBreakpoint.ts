import { useEffect, useState } from 'react'

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

function read(width: number): Breakpoint {
  if (width < 768) return 'mobile'
  if (width < 1200) return 'tablet'
  return 'desktop'
}

/** Mirrors the prototype's breakpoints: <768 mobile, 768–1199 tablet, ≥1200 desktop. */
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
