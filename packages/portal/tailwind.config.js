/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#edf8ff',
          100: '#d7efff',
          200: '#b0deff',
          400: '#43b6ff',
          500: '#1e9bff',
          600: '#0d84eb',
          700: '#0d68be',
        },
      },
    },
  },
  plugins: [],
};
