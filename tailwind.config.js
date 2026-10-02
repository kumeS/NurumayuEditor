/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // A calm, readable serif stack for the writing surface; sans for chrome.
        serif: ["Georgia", "Charter", "Cambria", "Times New Roman", "serif"],
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Hiragino Kaku Gothic ProN",
          "Meiryo",
          "sans-serif",
        ],
      },
      colors: {
        ink: {
          DEFAULT: "#1f2933",
          soft: "#3e4c59",
          faint: "#7b8794",
        },
        accent: {
          DEFAULT: "#2563eb",
          soft: "#3b82f6",
        },
        // State colors (docs/ai/04_design_tokens.md): used only to convey
        // state, never decoration. Values match the Tailwind scales they
        // replaced, so migrating a class changes no pixel.
        warn: {
          DEFAULT: "#d97706", // unsaved / stale / degraded text
          strong: "#b45309", // warning text on a tinted background
          dot: "#fbbf24", // small status dots
          tint: "#fef3c7", // warning pill background
          wash: "#fffbeb", // hover wash on warning rows
          line: "#fde68a", // warning box border
        },
        danger: {
          DEFAULT: "#b91c1c", // error headline text
          line: "#fecaca", // error box border
          wash: "#fef2f2", // error box background
        },
        ok: {
          DEFAULT: "#10b981", // saved / healthy dots
        },
        // Neutral chrome surfaces (status strip, panel borders, hover).
        chrome: {
          DEFAULT: "#f9fafb", // status strip background
          line: "#e5e7eb", // borders between chrome regions; hover fill
          hairline: "#f3f4f6", // inner dividers; subtle hover fill
          edge: "#d1d5db", // control outlines, slide-canvas frame, wireframe bars
        },
        // Diff roles ("Changes since last save"): added vs removed text.
        // Separate from warn/danger — a removal is not an error.
        additive: {
          DEFAULT: "#047857", // "Added" section heading
          mark: "#a7f3d0", // inserted-word highlight (used at /70)
          wash: "#ecfdf5", // added-paragraph row background
        },
        removed: {
          DEFAULT: "#dc2626", // "Removed" section heading
          mark: "#fecaca", // deleted-word strike highlight (used at /50)
          wash: "#fef2f2", // removed-paragraph row background
        },
      },
      maxWidth: {
        prose: "44rem",
      },
    },
  },
  plugins: [],
};
