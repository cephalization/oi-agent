import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    entry: { oi: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist",
    clean: true,
    // One self-contained file, so the linked command works from any directory.
    noExternal: [/.*/],
    dts: false,
  },
})
