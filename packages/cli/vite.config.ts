import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    // The launcher is what `oi` runs; it starts `oi.mjs`, and starts it again on /reload.
    entry: { oi: "src/main.ts", launcher: "src/launcher.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist",
    clean: true,
    // One self-contained file, so the linked command works from any directory.
    noExternal: [/.*/],
    dts: false,
  },
})
