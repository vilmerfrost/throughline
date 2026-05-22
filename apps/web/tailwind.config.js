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
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
