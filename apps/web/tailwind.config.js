/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Backed by the CSS vars in index.css — utilities like border-trust-asserted,
        // bg-trust-contract, stroke-edge-read resolve to the semantic tokens.
        trust: {
          contract: 'var(--color-contract)',
          verified: 'var(--color-verified)',
          narrowed: 'var(--color-narrowed)',
          asserted: 'var(--color-asserted)',
          dark: 'var(--color-dark)',
          // schema-match axis (deep-parsed writes) — see index.css.
          aligned: 'var(--color-aligned)',
          mismatch: 'var(--color-mismatch)',
        },
        edge: {
          read: 'var(--color-edge-read)',
          write: 'var(--color-edge-write)',
        },
        ai: 'var(--color-ai)',
        node: 'var(--color-bg-node)',
        popover: 'var(--color-bg-popover)',
        // Cool-slate neutral ramp — a desaturated push toward the contract blue
        // at the SAME luminance as Tailwind's default neutral, so legibility/
        // contrast are preserved and only the hue shifts. Remapping the ramp
        // (vs. editing every component) re-tints all the existing bg-neutral-*,
        // border-neutral-*, text-neutral-* utilities cohesively in one place.
        neutral: {
          50: '#f8fafc',
          100: '#f3f5f7',
          200: '#e2e5ea',
          300: '#cbd1d9',
          400: '#9aa1ad',
          500: '#6b7280',
          600: '#4a515d',
          700: '#353b46',
          800: '#262c37',
          900: '#15181e',
          950: '#0b0d10',
        },
      },
      boxShadow: {
        // The two elevation tiers, sourced from the CSS vars so the depth ladder
        // lives in one place (index.css) alongside the surface tokens.
        elev1: 'var(--elev-1)',
        elev2: 'var(--elev-2)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
