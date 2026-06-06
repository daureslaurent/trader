/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          base: 'var(--surface-base)',
          card: 'var(--surface-card)',
          elevated: 'var(--surface-elevated)',
          hover: 'var(--surface-hover)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
        },
        buy: {
          DEFAULT: 'rgb(var(--buy-rgb) / <alpha-value>)',
        },
        sell: {
          DEFAULT: 'rgb(var(--sell-rgb) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'rgb(var(--warn-rgb) / <alpha-value>)',
        },
        border: 'var(--border-color)',
        foreground: 'var(--foreground)',
        muted: 'var(--muted-fg)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      keyframes: {
        slideDown: {
          from: { transform: 'translateY(-8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        slideUp: {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'slide-down': 'slideDown 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'fade-in': 'fadeIn 0.15s ease-out',
      },
    },
  },
  plugins: [],
}
