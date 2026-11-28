import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The player serves this build at / (src/ppvio/adapters/http/server.py).
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/gsap") || id.includes("node_modules/@gsap")) return "vendor-gsap";
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) return "vendor-motion";
          if (id.includes("node_modules/react")) return "vendor-react";
          return undefined;
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
  test: { environment: "jsdom" },
});
