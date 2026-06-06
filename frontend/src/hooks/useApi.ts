import { useState, useEffect, useCallback } from 'react'

interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useApi<T>(url: string, deps: unknown[] = []) {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null })

  const reload = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setState({ data: await res.json() as T, loading: false, error: null })
    } catch (e) {
      setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'Request failed' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps])

  useEffect(() => { reload() }, [reload])

  return { ...state, reload }
}
