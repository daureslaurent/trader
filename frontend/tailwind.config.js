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
        accent2: {
          DEFAULT: 'rgb(var(--accent2-rgb) / <alpha-value>)',
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
      boxShadow: {
        soft: 'var(--shadow-card)',
        glow: '0 0 0 1px rgb(var(--accent-rgb) / 0.2), 0 4px 24px -4px rgb(var(--accent-rgb) / 0.35)',
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
        scaleIn: {
          from: { transform: 'scale(0.97)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        flowLine: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.9', transform: 'scale(1.12)' },
        },
        dashDraw: {
          to: { strokeDashoffset: '0' },
        },
      },
      animation: {
        'slide-down': 'slideDown 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'fade-in': 'fadeIn 0.15s ease-out',
        'scale-in': 'scaleIn 0.18s ease-out',
        'flow-line': 'flowLine 1.4s linear infinite',
        'glow-pulse': 'glowPulse 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
