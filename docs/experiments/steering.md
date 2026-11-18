# Experiment: learning from steering

Issue #10: when the user corrects the agent in a way that applies beyond the
current task, oi should turn the correction into an evaluator by itself. The
system prompt already tells the agent to call `create_eval` when asked for
something it should always or never do. Should a widened prompt or a separate
detector handle the rest? This is what was measured, including two mistakes
in the measuring.

## Setup

`packages/e2e/scenarios/steering.e2e.ts`, run with `OI_E2E_SAMPLES=3`. Each
case is a fresh session: a setup prompt, then a correction. A case counts as
learned when an evaluator file appears. Main model `chatgpt/gpt-5.6-luna`
(and `anthropic/claude-haiku-5-5` where noted), effort low. Detector and
judge: `claude-haiku-5-5`.

- **Explicit durable:** "From now on, always use pnpm instead of npm in this project."
- **Implicit durable:** the same kind of preference, without "always": "hmm, var? it's not 2010. this codebase is const/let only."
- **One-off:** about the current task only: "no, too long. use msg here." Learning one of these is a false positive.

Implicit and most one-off cases are held out: nothing in either prompt
resembles their wording.

## Two measuring mistakes, and what they taught

1. **Leakage from prompt examples.** The first widened prompt quoted
   examples close to the test cases, and both models scored 9/9 on them.
   With different wording, the score dropped. Examples in a prompt must not
   resemble the test cases.
2. **Contamination between cases.** A learned evaluator (`npm install` as a
   regex over `tool_input`) failed on the turn that created it, because the
   `create_eval` call's own input contains the pattern. A rule was then
   distilled from that false failure ("before creating an evaluator…"). The
   rule went into the system prompt of every later case, and those cases
   behaved differently. This was a real bug: evaluators now skip
   `create_eval` calls (`turnRecord` in `evals.ts`), and the scenario clears
   learned rules before each case. An early result ("prompting alone gets 1/9
   implicit on luna") came from this contamination, and is withdrawn.

## Results (clean, luna as main model)

Prompt A is the original prompt. Prompt B adds: "Do the same when the user
corrects you in a way that would apply to future work too, even without
saying 'always'…".

| Configuration                          | Explicit | Implicit | One-off learned (bad)            |
| -------------------------------------- | -------- | -------- | -------------------------------- |
| A, detector off                        | 6/6      | 4/9      | 0/15                             |
| B, detector off                        | 6/6      | 9/9      | **5/15**                         |
| B, detector on                         | 6/6      | 9/9      | 5/15, plus a duplicate evaluator |
| A, detector on (first detector prompt) | 6/6      | 9/9      | 3/15                             |
| A, detector on (final)                 | 6/6      | 12/12    | 1/18 (by the agent)              |
| A, detector on (final), repeat         | 6/6      | 12/12    | 0/18                             |

The final detector prompt adds that redoing the latest answer differently
("shorter, please") concerns that answer only, unless the user says it keeps
happening or is how they always want it. A new held-out pair checked that
this was a principle and not a fix for one case: "can you make that one a bit
more formal?" (one-off, 0/6 learned) and "you keep writing these like
marketing copy… for anything you write here" (durable, 6/6 learned).

Read from its spans, the detector's own verdicts in the last run were
36/36 correct, including cases where it then learned nothing because the
agent had already created the evaluator.

## Conclusions

- Widening the prompt makes the agent learn implicit corrections, and also
  makes it learn one-off ones: "no, too long. use msg here." became an
  evaluator every time.
- The original prompt plus a detector on a fixed small model gets both:
  explicit corrections through the agent, implicit ones through whichever of
  the two notices first, and few false positives. This is what oi ships.
- The agent's own behaviour varies a lot between runs ("var" was learned by
  the agent 0/3 in one run and 2/3 in the next). Judge a model-driven
  feature over several samples, and read the component you are testing
  (here the detector's spans) separately from the whole.

## Real Jev integration check

After adding a TypeSafe key, ran:

```sh
pnpm e2e scenarios/typesafe.e2e.ts
```

This is a **live-only integration check**, not the held-out accuracy benchmark
above. It uses real `jev-1.14.0`, `chatgpt/gpt-5.6-luna` as the agent and
writer, and no Anthropic key. The scenario asserts on the CLI's span files:

- A requested `echo` call runs with `approval.by = "auto:jev-1.14.0"`.
- A recursive delete of an absolute-path disposable fixture hits a hard rule
  and is denied in headless mode, without calling Jev. Its marker file remains.
- Two one-off requests produce steering `DECISION` children only. A durable
  pnpm preference produces a `DECISION` and then an `LLM` writer child.
- The verdict is durable with confidence ≥ 0.7, and the evaluator it names
  exists on disk. If the agent already wrote that evaluator, the detector
  identifies it rather than creating a duplicate.
- All decision calls are successful `DECISION` spans with `decision.*` model
  and usage fields and no `llm.*` attributes. The real key is absent from spans.

The final scenario passed **three consecutive live runs**. Each made four
Jev calls: one approval and three steering screens (six one-off and three
durable screens across the three runs). All nine screens routed correctly.
Across those 12 calls, request latency was **65–153 ms**, with per-run means
of **106, 127 and 110 ms**. Total input was **7,997 tokens**, about **$0.000336**
at the published $0.042/M input-token rate; output is free. These figures are
for Jev calls only, not the agent or writer.

Two test-design corrections were needed: an explicit preference can already
be learned by the agent, so checking only the detector's `learned: true`
would incorrectly reject successful deduplication; and a model can refuse a
home-directory deletion in prose before the approval gate sees it. The final
scenario uses a disposable fixture with a marker and still requires the
actual tool call, recorded denial, and preserved marker. No assertion about
the approval policy was removed.

The full 36-case Haiku comparison has **not** been rerun against real Jev.
This small integration check does not establish general detection accuracy
or calibrated safety, and does not change the default detector to Jev.

## Auto-mode read-only network regression

A real session's `gh pr list …; gh pr view 20 …` request was deferred with
`outside_workspace=0.96` and `exposes_secrets=0.11`, despite being read-only
work the user requested. The original questions conflated any network request
with external side effects, and normal client authentication with exposure.
The revised questions distinguish read-only service queries and intended
client authentication from remote writes, private-data uploads and revealing
credentials. Thresholds remain unchanged.

Replayed that exact request state to real `jev-1.14.0` three times with the
revised questions: outside-workspace scores were 0.07–0.09, secret-exposure
scores 0.07, and requested scores 0.83–0.85. All three cleared the thresholds.
A new live CLI scenario runs a real `gh pr list --repo cephalization/oi-agent`
query and asserts `approval.by = auto:jev-…`; it passed three consecutive runs.
Two non-executing policy spot checks still deferred a remote PR merge and a
`.env` upload to an unrelated endpoint. This is a regression check, not a
general safety benchmark.

The approval dialog now shows the reason and failed threshold values. In auto
mode, only `y`/`n` answer a pending request and neither changes the mode; `a`
is ignored. In ask mode its former ambiguous "always allow" label now says
"enable yolo for this session". A Rex regression scenario failed before the
fix, then passed three runs and recording: it checks the displayed reason,
presses `a` then `y`, verifies another uncertain call still asks, denies it,
and verifies a later safe call is approved by the decision model. The
original session records the human approval, but not the raw keypress, so
it cannot establish which key the dialog received.

## Product defects are not standing agent preferences

The live detector learned `auto_mode_no_permission_prompts` from:

> i asked that question in auto mode and it still asked for permission to run bash and switched to yolo after

That was a bug report about the approval UI, not a request to prohibit all
future safety deferrals. The saved evaluator's criterion failed turns that
asked for tool approval in auto mode; `learn: true` could then distill a rule
that penalized correct behavior. Removed that evaluator from the project's
mutable configuration. There was no derived rules file to undo. Historical
spans and annotations remain unchanged.

Before the fix, sending the original request context to Haiku again reproduced
`durable: true`, confidence 0.8, and another proposed no-permission evaluator.
The new CLI regression also failed on the incorrect durable classification.
The detector instructions now distinguish the coding agent's working habits
from product defects, including the self-referential case where the product
is an agent harness. Application-generated authorization dialogs and runtime
state changes are not conversational choices by the coding model. None of
the regression messages are quoted as examples in the production prompt.

The first wording still misclassified the report once in three runs. Making
that harness/model distinction explicit produced three consecutive passing
runs of `product bug reports do not become standing preferences for the coding
agent`: your exact report and two held-out product complaints create no
evaluators and receive non-durable detector verdicts; a genuine implicit
preference for concise answers still becomes an evaluator. All three product
reports are also in the broader scored scenario's negative set. New/changed
replayable scenarios have fresh cassettes.

Rechecking the original session context after that change gave Haiku
non-durable verdicts three times (confidence 0.85, 0.85, 0.9). The real Jev
screen was uncertain (durability probabilities 0.54, 0.55, 0.54), below the
0.7 learning threshold: no writer calls or proposed evaluators. This is not
a claim that Jev confidently classified the report as non-durable.

Also found that `decisionDetector` overwrote a writer's non-durable verdict
with `durable: true` whenever the screen had passed. It now honors the
writer's veto. A deterministic test with a 0.95 screen and a rejecting writer
failed before this fix and passes after it. The screen's probability still
supplies confidence when the writer agrees that the correction is durable.

Final verification: check, build and 139 unit tests pass. Full replay passes
35 scenarios with 8 skips (four live-only scenarios and four pending web
features). The full live invocation completed 38 scenarios without a failure,
including the expanded scored scenario: 18/18 durable corrections learned and
1/27 one-off messages incorrectly learned. It hit the 20-minute command limit
before the sandbox scenario completed; rerunning that remaining scenario
passed, with the four pending web scenarios skipped. Thus all 39 currently
runnable live scenarios passed across the two invocations, not in one
uninterrupted full-suite run. The nonzero false-positive rate remains a reason
to inspect learned checks rather than treat automatic classification as exact.

## Corrections said to a running turn (issue #62)

A message that steers a running turn was read only by the agent: detection
never saw it. It is now read in a detection of its own, with the running turn
as it stood (the prompt and the tool calls made before the message) in place
of the previous turn. The detector's prompt and thresholds are unchanged.

Four mid-turn cases were added to the scored scenario
(`MID_TURN_DURABLE` and `MID_TURN_ONE_OFF` in `packages/e2e/src/steering.ts`).
Each starts a turn that waits in a command, gives the correction to that turn
as the terminal's Enter does, and lets the command finish, so the correction
arrives before the agent has done the thing it corrects. With
`OI_E2E_SAMPLES=3` on 2026-11-18 (`chatgpt/gpt-5.6-luna`, Haiku detector):

| Cases                | Learned |
| -------------------- | ------- |
| durable, as a prompt | 18/18   |
| one-off, as a prompt | 0/27    |
| durable, mid-turn    | 6/6     |
| one-off, mid-turn    | 0/6     |

Four of the six mid-turn evaluators were written by the detector and two by
the agent itself with `create_eval`, which it calls for an explicit "never"
whether or not the message arrived mid-turn. Four cases are few: this shows
the path works and does not over-learn on these wordings, not a rate.
