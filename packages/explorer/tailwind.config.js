/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0a0a0f",
          surface: "#12121a",
          border: "#1e1e2e",
        },
        profit: "#00ff88",
        loss: "#ff3366",
        amber: "#ffaa00",
        txt: {
          primary: "#e0e0e8",
          secondary: "#6b6b80",
        },
      },
      fontFamily: {
        display: ["Outfit", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
