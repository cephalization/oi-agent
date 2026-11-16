/**
 * Evaluator applicability (issue #33): a check says when it applies, and a
 * turn it does not apply to is recorded as skipped, with the evidence, and
 * without running it. Commits are detected from what Git did, not from the
 * command text.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { type AnnotationFile, decodeEvalDefinition, kindOf, projectDir, readMetadata } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, type Scenario, scenario } from "../src/scenario.ts"

const evalsDir = (s: Scenario): string =>
  path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")

const annotations = (s: Scenario, name: string): Array<AnnotationFile> =>
  s.spans
    .sessions()
    .flatMap((id) => s.spans.store.listAnnotations(id))
    .filter((file) => file.annotation.name === name)

/** Model calls an evaluator made: an `LLM` span inside an `EVALUATOR` trace for this check. */
const judgeCalls = (s: Scenario, name: string): number =>
  s.spans.sessions().reduce((total, session) => {
    const traces = s.spans.store.listTraceIds(session).map((id) => s.spans.store.readTrace(session, id).ended)

    return (
      total +
      traces
        .filter((spans) => spans.some((span) => span.parent_id === null && span.name === `eval ${name}`))
        .flatMap((spans) => spans.filter((span) => kindOf(span) === "LLM")).length
    )
  }, 0)

/** The sandbox project's evaluators, read from its config directory. */
const loadProjectEvals = (s: Scenario) =>
  fs.existsSync(evalsDir(s))
    ? fs
        .readdirSync(evalsDir(s))
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const definition = decodeEvalDefinition(
            JSON.parse(fs.readFileSync(path.join(evalsDir(s), name), "utf8")),
          )

          return definition === undefined ? [] : [definition]
        })
    : []

const COMMIT_PROMPT =
  "Call the bash tool now with this exact command, without asking me first: printf 'new content' > applicability.txt && git add applicability.txt && git -c user.name=Test -c user.email=test@example.com commit -m 'test: evidence'. Then reply done."

describe("evaluator applicability", () => {
  scenario(
    "a commit check skips discussion and runs on a bash commit",
    { config: new Map([["steering", "off"]]) },
    async (s) => {
      fs.mkdirSync(evalsDir(s), { recursive: true })
      fs.writeFileSync(
        path.join(evalsDir(s), "commit_check.json"),
        JSON.stringify({
          name: "commit_check",
          description: "Check commits",
          kind: "code",
          pattern: "never-match-this",
          target: "output",
          match_label: "fail",
          otherwise_label: "pass",
          fail_labels: ["fail"],
          feedback: true,
          learn: false,
          applicability: { any: ["commit"] },
        }),
      )

      expectOk(await s.run(["run", "Reply with exactly pong."]))
      expect(annotations(s, "commit_check").map((file) => file.annotation.label)).toEqual(["skipped"])

      expectOk(await s.run(["run", COMMIT_PROMPT, "--yolo"]))

      const session = s.spans.sessions().at(-1) ?? ""
      const bash = s.spans.tools(session).find((tool) => tool.name === "bash")

      expect(bash?.input).toContain("commit")
      expect(readMetadata(s.spans.ended(session).find((span) => span.name === "bash")!).evidence).toEqual({
        writes: "yes",
        commit: "yes",
      })
      expect(annotations(s, "commit_check").map((file) => file.annotation.label)).toEqual(["skipped", "pass"])
    },
  )

  scenario(
    "create_eval records a commit trigger, and a discussion turn skips the judge",
    { config: new Map([["steering", "off"]]) },
    async (s) => {
      expectOk(
        await s.run([
          "run",
          "Set up a standing check with create_eval, now, without asking me: whenever you make a git commit, the committed changes must get a pull request, or you must say that opening one is blocked. Do nothing else.",
          "--yolo",
        ]),
      )

      const [created] = loadProjectEvals(s)

      expect(created?.applicability?.any).toContain("commit")
      expect(created?.applicability?.all ?? []).not.toContain("writes")

      expectOk(await s.run(["run", "Reply with exactly pong."]))

      const name = created?.name ?? ""

      // The creation turn and the discussion turn: neither made a commit.
      expect(annotations(s, name).length).toBeGreaterThan(0)
      expect(new Set(annotations(s, name).map((file) => file.annotation.label))).toEqual(new Set(["skipped"]))
      expect(judgeCalls(s, name)).toBe(0)
    },
  )

  scenario(
    "a steering-learned PR check is triggered by commits",
    { config: new Map([["steering", "auto"]]) },
    async (s) => {
      expectOk(
        await s.run([
          "run",
          "You committed again and never opened a pull request. From now on, always open a PR after you commit in this project. Do not call any tools for this message; reply with just: understood",
        ]),
      )

      // The agent sometimes writes the check itself with create_eval, and the
      // detector then finds it covered; either way the trigger must be commits.
      const [learned] = loadProjectEvals(s)

      expect(learned, "a check was learned").toBeDefined()
      expect(learned?.applicability?.any).toContain("commit")
      s.note(
        `learned by ${learned?.origin?.kind === "steering" ? "the steering detector" : "the agent (create_eval)"}`,
      )
    },
  )
})
