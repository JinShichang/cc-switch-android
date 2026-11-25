import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname.replace(
        /^\/(?:([A-Za-z]:))/,
        "$1",
      ),
    },
  },
  base: "./",
  server: {
    watch: { ignored: ["**/android/**", "**/native/**", "**/.local/**"] },
  },
  build: {
    target: "es2022",
    outDir: "android/app/src/main/assets/web",
    emptyOutDir: true,
    sourcemap: false,
  },
});
