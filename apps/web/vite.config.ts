import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));

// The app reads the catalog and Gno sources straight from the repository,
// so a build always matches the commit it was made from.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  server: { fs: { allow: [repo] } },
  build: { target: "es2024", chunkSizeWarningLimit: 1500 },
});
