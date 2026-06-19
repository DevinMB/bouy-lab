import { useState, useEffect } from 'react'

// Tracks whether the viewport is at/below a width breakpoint (default 640px),
// kept in sync with the CSS media query used for the mobile layout.
export function useIsNarrow(maxWidth = 640) {
  const query = `(max-width: ${maxWidth}px)`
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e) => setNarrow(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])
  return narrow
}
