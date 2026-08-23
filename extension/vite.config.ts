import { defineConfig } from "vite";
import { resolve } from "path";

// We use a multi-entry build without crxjs. The manifest is copied as-is.
// Each entry is a separate rollup input so they bundle independently.

const inputs: Record<string, string> = {
  "background": resolve(__dirname, "src/background.ts"),
  "offscreen": resolve(__dirname, "src/offscreen.ts"),
  "popup": resolve(__dirname, "src/popup.ts"),
  "pages/panel": resolve(__dirname, "src/pages/panel.ts"),
  "pages/transcript": resolve(__dirname, "src/pages/transcript.ts"),
  "pages/summary": resolve(__dirname, "src/pages/summary.ts"),
  "pages/settings": resolve(__dirname, "src/pages/settings.ts"),
  "pages/history": resolve(__dirname, "src/pages/history.ts"),
};

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: inputs,
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[ext]",
      },
    },
    // Silence warnings about dynamic imports in service workers
    target: "esnext",
    minify: false,
    sourcemap: process.env.NODE_ENV === "development",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
