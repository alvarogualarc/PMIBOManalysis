/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pmi: {
          blue: '#003087',
          light: '#0051a8',
        },
      },
    },
  },
  plugins: [],
}
