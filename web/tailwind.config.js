import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(here, "index.html"), path.join(here, "src/**/*.{js,jsx,ts,tsx}")],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
          950: "#020617"
        },
        accent: {
          50: "#fef3c7",
          100: "#fde68a",
          400: "#facc15",
          500: "#eab308",
          600: "#ca8a04"
        },
        success: {
          500: "#22c55e",
          600: "#16a34a"
        },
        warn: {
          500: "#f97316",
          600: "#ea580c"
        },
        danger: {
          500: "#ef4444",
          600: "#dc2626"
        }
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      }
    }
  },
  plugins: []
};
