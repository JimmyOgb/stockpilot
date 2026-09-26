/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        stockpilot: {
          dark: '#1D3045',
          navy: '#1D3045'
        }
      },
      fontFamily: {
        sans: [
          'Helvetica Neue ME',
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'sans-serif'
        ]
      }
    }
  },
  plugins: []
};
