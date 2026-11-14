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
