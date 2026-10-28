import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { themeInitScript } from "@cqu-moe/theme";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "theme-init",
      transformIndexHtml: () => [
        { tag: "script", children: themeInitScript, injectTo: "head-prepend" },
      ],
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3030" },
  },
  build: { outDir: "dist" },
});
