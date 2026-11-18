/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}", "./public/index.html"],
  theme: {
    extend: {
      colors: {
        forest: {
          DEFAULT: "#2D4A22",
          50: "#EEF2EB",
          100: "#DCE5D5",
          200: "#B6C8A9",
          600: "#3A5E2C",
          700: "#2D4A22",
          800: "#223818",
          900: "#18280F",
        },
        terracotta: {
          DEFAULT: "#D97757",
          50: "#FBEEE9",
          100: "#F6DCD2",
          600: "#C4623F",
          700: "#A64F31",
        },
        cream: "#F7F5F0",
        sand: "#EDE9E0",
        line: "#E3DED3",
        ink: "#1F2A1B",
        muted: "#6B6F63",
        danger: "#C0392B",
      },
      fontFamily: {
        heading: ["Manrope", "system-ui", "sans-serif"],
        sans: ["'IBM Plex Sans'", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(31,42,27,0.04), 0 1px 1px rgba(31,42,27,0.03)",
        lift: "0 8px 24px -12px rgba(31,42,27,0.25)",
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
        "fade-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-up": "fade-up 0.35s ease-out both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
