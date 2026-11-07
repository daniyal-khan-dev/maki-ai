// The page (client/): React + TypeScript. `npm start` serves it through Vite with live reload;
// `npm run build` writes it to dist/ for `npm run serve`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL("./client", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
