import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vite-plus"

const ignored = [".claude/**", "**/CHANGELOG.md", "tools/oxlint/anti-slop/**", "dist/**", "**/dist/**"]

export default defineConfig({
  fmt: {
    semi: false,
    printWidth: 110,
    ignorePatterns: ignored,
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
    options: { typeAware: true, typeCheck: true },
    env: { node: true },
    ignorePatterns: ignored,
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
    overrides: [
      {
        // End-to-end scenarios are declared with `scenario()`, which wraps `it()`.
        files: ["packages/e2e/**"],
        rules: {
          "vitest/no-standalone-expect": ["warn", { additionalTestBlockFunctions: ["scenario"] }],
          "vitest/expect-expect": ["warn", { assertFunctionNames: ["expect", "expectOk"] }],
        },
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    // Tests must never read or write the developer's real configuration.
    env: { OI_AGENT_CONFIG_DIR: join(tmpdir(), "oi-agent-test-config") },
  },
  staged: { "*": "vp check --fix" },
})
