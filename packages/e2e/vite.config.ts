import { defineConfig } from "vite-plus"

export default defineConfig({
  test: {
    include: ["scenarios/**/*.e2e.ts"],
    // Scenarios start real processes and call real models: one at a time,
    // with room for a slow turn.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
  },
})
