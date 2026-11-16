import { defineConfig } from "vite-plus"
import { positiveInteger } from "./src/samples.ts"

export default defineConfig({
  test: {
    // Scored experiments take minutes, so they are their own run: `pnpm e2e:scored`.
    include: [process.env["OI_E2E_SCORED"] === "1" ? "scenarios/**/*.scored.ts" : "scenarios/**/*.e2e.ts"],
    // Scenarios start real processes and call real models, each in its own
    // sandbox: files run side by side, and the scenarios in a file in order,
    // with room for a slow turn.
    maxWorkers: positiveInteger("OI_E2E_WORKERS", 4),
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
  },
})
