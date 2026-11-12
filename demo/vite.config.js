// vite.config.js (demo)
// Build settings for the public demo only. The real site keeps using the
// vite.config.js in the main folder.
//
// Build it with:  npx vite build --config demo/vite.config.js
// The finished site lands in demo/dist/ (ignored by Git, like the main dist/).

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "demo", // the demo's index.html lives here
  base: "/fantasy-assistant/", // GitHub Pages serves it at mmcgrath-dev.github.io/fantasy-assistant/
  publicDir: "../public", // same favicon and icons as the real site
  build: { outDir: "dist", emptyOutDir: true },
});
