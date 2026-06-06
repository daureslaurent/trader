import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

export type Theme = 'dark' | 'midnight' | 'neon' | 'light'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'dark', setTheme: () => {} })

export const THEMES: { id: Theme; label: string; swatch: string; bg: string }[] = [
  { id: 'dark',     label: 'Dark',     swatch: '#22c55e', bg: '#111115' },
  { id: 'midnight', label: 'Midnight', swatch: '#60a5fa', bg: '#0c1528' },
  { id: 'neon',     label: 'Neon',     swatch: '#22d3ee', bg: '#0a0f1e' },
  { id: 'light',    label: 'Light',    swatch: '#16a34a', bg: '#ffffff' },
]

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem('cb-theme') as Theme) || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('cb-theme', theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
