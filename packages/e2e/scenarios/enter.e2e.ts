/**
 * What Enter does (issue #56). The line under the prompt says what pressing
 * Enter will do, from the conversation's own state: start a turn, say
 * something to the turn that is running, or queue behind it. Each scenario
 * checks the screen before the key is pressed, then the span files after.
 *
 * The slow commands wait for a file the scenario creates, not for a length
 * of time, so a turn is running for exactly as long as a scenario needs.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { jobsOf, kindOf, OI, pendingInbox, readMetadata, renderSteer, stringAttr } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { type Scenario, scenario } from "../src/scenario.ts"
import type { Terminal } from "../src/term.ts"

const GATED = "until [ -f go ]; do sleep 0.2; done; echo gate-opened"

const release = (s: Scenario): void => fs.writeFileSync(path.join(s.sandbox.cwd, "go"), "")

const IDLE = /enter starts a new turn/
const STEERS = /enter steers the running turn · ctrl\+t to queue for the next turn instead/
const QUEUES = /enter queues for the next turn · ctrl\+t to steer the running turn instead/

/** Start a turn that stays in its bash call until `release`, and return its session. */
const startGatedTurn = async (s: Scenario, term: Terminal, then: string): Promise<string> => {
  await term.waitFor(/Every step is an OpenInference span/)
  await term.waitFor(IDLE)
  await term.line(
    `Call the bash tool now with exactly the command \`${GATED}\` and no other arguments. ${then}`,
  )

  const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

  await s.spans.waitFor("the bash call to be in flight", () =>
    s.spans.open(session).find((span) => kindOf(span) === "TOOL"),
  )

  return session
}

/** Every request body the session's turns sent, joined. */
const requests = (s: Scenario, session: string, turn: number): string =>
  s.spans
    .trace(session, s.spans.turns(session)[turn]?.trace_id ?? "")
    .filter((span) => kindOf(span) === "LLM")
    .map((span) => stringAttr(span, OI.INPUT_VALUE) ?? "")
    .join("\n")

describe("what Enter does", () => {
  scenario(
    "Shift+Enter inserts a newline and the idle hint lists hotkeys",
    { needs: ["rex"], config: new Map([["steering", "off"]]) },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/enter starts a new turn · shift\+enter newline/)
      await term.send("Reply with exactly")
      await term.key("shift+enter")
      await term.send("the word pong")
      const session = s.spans.onlySession()

      expect(s.spans.turns(session)).toHaveLength(0)
      await term.key("enter")
      const [turn] = await s.spans.settledTurns(session, 1)

      expect(turn?.input).toBe("Reply with exactly\nthe word pong")
      expect(turn?.state).toBe("complete")
    },
  )

  scenario(
    "Escape stops idle background jobs without dispatching a result turn",
    { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(IDLE)
      await term.line(
        `Call the bash tool now with command \`${GATED}\` and background true. Then reply with just: started.`,
      )
      const session = s.spans.onlySession()

      await s.spans.settledTurns(session, 1)
      await term.waitFor(/background work keeps running · esc stop all/)
      const jobs = jobsOf(s.spans.store)
      const running = jobs.running(session)

      expect(running).toHaveLength(1)
      await term.key("escape")
      await s.spans.waitFor("the job to be killed", () =>
        running.every((job) => jobs.state(job).state === "killed") ? true : undefined,
      )
      await term.waitFor(/enter starts a new turn · shift\+enter newline/)
      expect(s.spans.turns(session)).toHaveLength(1)
      await term.line("Reply with exactly the word: pong")
      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[1]?.input).toBe("Reply with exactly the word: pong")
    },
  )

  scenario(
    "Escape withdraws queued prompts and restores them through history",
    { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
    async (s) => {
      const term = await s.tui()
      const session = await startGatedTurn(s, term, "Then reply with just: done.")

      await term.key("ctrl+t")
      await term.waitFor(QUEUES)
      await term.line("Reply with exactly the word: older")
      await term.line("Reply with exactly the word: latest")
      await term.waitFor(/⧗ queued for the next turn: Reply with exactly the word: latest/)
      await term.key("escape")
      await s.spans.settledTurns(session, 1)
      await term.waitFor(/› Reply with exactly the word: latest/)
      expect(pendingInbox(s.spans.store, session)).toEqual([])
      expect(s.spans.turns(session)).toHaveLength(1)
      await term.key("up")
      await term.waitFor(/› Reply with exactly the word: older/)
      await term.key("down")
      await term.waitFor(/› Reply with exactly the word: latest/)
      await term.key("enter")
      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[1]?.input).toBe("Reply with exactly the word: latest")
      expect(s.spans.turns(session)).toHaveLength(2)
    },
  )

  scenario(
    "idle, Enter starts a new turn, and still does while background work runs",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/Every step is an OpenInference span/)

      const idle = await term.waitFor(IDLE)

      expect(idle).not.toMatch(/background work keeps running/)

      await term.line(
        `Call the bash tool now with the command \`${GATED}\` and background set to true. ` +
          "Then call no more tools and reply with just: started. When its result is delivered to you later, reply with just: finished.",
      )

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)

      // Work is running, but no turn is: the conversation is free, and the line says so.
      await term.waitFor(/⚙ job [0-9a-f]+ /)
      await term.waitFor(/enter starts a new turn · background work keeps running/)
      await term.line("Reply with exactly the word: pong")

      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[1]?.input).toBe("Reply with exactly the word: pong")
      expect(turns[1]?.output?.toLowerCase()).toContain("pong")
      expect(readMetadata(turns[1]!.root).inbox_id).toBeUndefined()

      release(s)
      await s.spans.waitFor("the delivery", () => (s.spans.turns(session).length === 3 ? true : undefined))
      await s.spans.settledTurns(session, 3)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )

  scenario(
    "during a turn, Enter steers it: the message reaches the running turn, not a new one",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()
      const session = await startGatedTurn(s, term, "Then reply with one short sentence saying it finished.")

      await term.waitFor(STEERS)
      await term.line("End your reply with the single word heron.")

      // Said, and visibly waiting for the step in flight to end.
      const waiting = await term.waitFor(/↳ steering, when the turn's current step ends: End your reply/)

      expect(waiting).not.toMatch(/queued for the next turn/)
      expect(pendingInbox(s.spans.store, session).map((entry) => entry.steers)).toEqual([true])
      expect(s.spans.turns(session)).toHaveLength(1)

      release(s)

      const [turn] = await s.spans.settledTurns(session, 1)

      expect(turn?.output?.toLowerCase()).toContain("heron")
      expect(s.spans.turns(session)).toHaveLength(1)

      // Where it was said is on the turn's root span, and the model read it after the tool result.
      const [steered] = readMetadata(turn!.root).steered ?? []
      const sent = requests(s, session, 0)

      expect(steered).toMatchObject({ user_id: "e2e", text: "End your reply with the single word heron." })
      expect(sent).toContain(JSON.stringify(renderSteer(steered!)).slice(1, -1))
      expect(sent.indexOf("gate-opened")).toBeLessThan(sent.indexOf("single word heron"))
      expect(pendingInbox(s.spans.store, session)).toEqual([])

      const screen = await term.waitFor(
        /↳ End your reply with the single word heron\. \(steered the running turn\)/,
      )

      expect(screen).not.toMatch(/↳ steering, when the turn's current step ends/)
      await term.waitFor(IDLE)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )

  scenario(
    "during a turn, ctrl+t makes Enter queue: the turn is left alone and the message runs next",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()
      const session = await startGatedTurn(s, term, "Then reply with just: first-done.")

      await term.waitFor(STEERS)
      await term.key("ctrl+t")
      await term.waitFor(QUEUES)
      await term.line("Reply with exactly the word: pong")

      const waiting = await term.waitFor(/⧗ queued for the next turn: Reply with exactly the word: pong/)

      expect(waiting).not.toMatch(/↳ steering/)
      expect(pendingInbox(s.spans.store, session).map((entry) => entry.steers)).toEqual([undefined])
      expect(s.spans.turns(session)).toHaveLength(1)

      release(s)

      const turns = await s.spans.settledTurns(session, 2)

      // The first turn never saw it; it is the second turn's prompt.
      expect(readMetadata(turns[0]!.root).steered).toBeUndefined()
      expect(requests(s, session, 0)).not.toContain("pong")
      expect(turns[0]?.output).toContain("first-done")
      expect(turns[1]?.input).toBe("Reply with exactly the word: pong")
      expect(turns[1]?.output?.toLowerCase()).toContain("pong")
      expect(pendingInbox(s.spans.store, session)).toEqual([])

      const screen = await term.waitFor(IDLE)

      expect(screen).not.toMatch(/⧗ queued for the next turn/)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )

  scenario(
    "a turn that ends while a message is being typed changes what Enter says before it is pressed",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()
      const session = await startGatedTurn(s, term, "Then reply with just: first-done.")

      await term.waitFor(STEERS)

      // Typed while the turn runs, but not sent.
      await term.send("Reply with exactly the word: pong")
      await term.waitFor(/› Reply with exactly the word: pong/)

      release(s)
      await s.spans.settledTurns(session, 1)

      // The turn it would have steered is gone: Enter now says it starts a turn, and does.
      const screen = await term.waitFor(IDLE)

      expect(screen).not.toMatch(STEERS)
      await term.key("enter")

      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[1]?.input).toBe("Reply with exactly the word: pong")
      expect(readMetadata(turns[0]!.root).steered).toBeUndefined()
      expect(readMetadata(turns[1]!.root).inbox_id).toBeUndefined()
      expect(s.spans.store.listInbox(session)).toEqual([])
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )

  scenario(
    "quitting with a message queued starts nothing, and oi -c runs it in the session that was left",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()
      const session = await startGatedTurn(s, term, "Then reply with just: first-done.")

      await term.waitFor(STEERS)
      await term.key("ctrl+t")
      await term.waitFor(QUEUES)
      await term.line("Reply with exactly the word: pong")
      await term.waitFor(/⧗ queued for the next turn: Reply with exactly the word: pong/)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)

      // Nobody is there: the turn was stopped, and the queued message did not start.
      release(s)
      expect(s.spans.turns(session)).toHaveLength(1)
      expect(pendingInbox(s.spans.store, session).map((entry) => entry.text)).toEqual([
        "Reply with exactly the word: pong",
      ])

      // -c is the session that was worked in, and opening it runs what was left.
      const back = await s.tui(["-c"])
      const turns = await s.spans.settledTurns(session, 2)

      expect(s.spans.sessions()).toEqual([session])
      expect(turns[1]?.input).toBe("Reply with exactly the word: pong")
      expect(turns[1]?.output?.toLowerCase()).toContain("pong")
      expect(pendingInbox(s.spans.store, session)).toEqual([])
      await back.waitFor(IDLE)
      await back.line("/quit")
      expect(await back.exited()).toBe(0)
    },
  )
})
