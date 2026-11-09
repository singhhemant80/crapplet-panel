import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "#a365fe", dark: "#7c3aed", deep: "#4c1d95", soft: "#f3e8ff", tint: "#faf5ff" },
        ink: "#0f172a",
        mute: "#64748b",
        line: "#ece4fb",
      },
      fontFamily: { sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"], display: ["Inter", "sans-serif"] },
      boxShadow: { card: "0 1px 2px rgba(15,23,42,.04), 0 8px 24px rgba(76,29,149,.06)", glow: "0 8px 22px rgba(124,58,237,.3)" },
    },
  },
  plugins: [],
} satisfies Config;
