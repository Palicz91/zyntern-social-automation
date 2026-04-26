/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        zyntern: {
          dark: "#1E0A3C",
          deep: "#3A1078",
          purple: "#6C2BA1",
          magenta: "#9B3DB7",
          coral: "#FF4B6E",
          yellow: "#FFD93D",
        },
      },
    },
  },
  plugins: [],
};
