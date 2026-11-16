# Delegation quality: ordinary requests, not tool scripts

Run only this experiment (cheap default `chatgpt/gpt-5.6-luna`):

```sh
OI_E2E_CONCURRENCY=3 pnpm e2e:scored scenarios/delegation-quality.scored.ts
```

Three repetitions of four requests under each of `delegation: auto` and
`delegation: off`: 24 isolated samples, no judge model. Change repetitions
with `OI_E2E_SAMPLES`. This is live-only (no cassette); replay skips both
scenarios with `needs live models`. Neither the ordinary suite nor the
existing scripted task scenarios are changed.

**Escape hatch:** set `"delegation": "off"` in
`~/.config/oi-agent/config.json` to keep work in the conversation.

## What is scored

Prompts ask for ordinary outcomes, never mention subagents, tool names,
parallelism or delegation. Fixtures are built in fresh sandboxes, not agent
instructions. The same prompts run under the off control.

| Case                       | Outcome checked                                                          | Choice hypothesis under auto |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| Quick edit                 | Correct spelling in the caller's checkout; execute its assertion         | No delegation                |
| Independent investigations | Count 503s in two regional logs and identify each failing backend        | At least two tasks           |
| Dirty dependency           | Change currency while retaining an uncommitted price; execute assertions | No delegation                |
| Warm dependencies          | Verify an ignored, already-installed local package without installation  | No delegation                |

The independent case is intentionally modest: whether two such investigations
really merit the startup/context cost is a policy judgment, not a correctness
fact. A low choice score alone is not a broken runtime. The warm dependency
is a tiny offline stand-in for a costly install, not an actual expensive
network install. We do not spend money to simulate provisioning.

Every sample checks the working copy independently and compares the parent's
reports with tool-output evidence across parent and child spans. For the
edit/check requests the verification marker must appear in both; for the
investigations a consolidated structured report must associate each count with its backend,
and all four facts must also appear in tool outputs. Later terse delivery
acknowledgements do not erase an earlier consolidated report. This catches
missing or unsupported reports, not every possible misleading natural-language
claim. It is not an LLM truthfulness judge. Task deliveries must name the
spawned task IDs. Completion/evidence must pass every sample; choice has a
separate per-case 2/3 bar, so easy cases cannot hide a failure to split work.
Off must make zero delegate calls.

Results JSON persists outside disposable sandboxes in `OI_E2E_RESULTS_DIR`
(default `$TMPDIR/oi-e2e-results`), with parent reports, exact tool inputs and
outputs, session/span IDs, linked tasks, model IDs, retries, wall latency,
agent model-call counts and prompt+completion tokens across **all** sessions.
Auxiliary steering/evaluator traces are excluded; this is workload cost, not
a whole-process billing total. Tokens
are a cost proxy, not dollars: the default uses a ChatGPT subscription and the
spans do not expose a marginal dollar price. Context tokens include repeated
history, deliberately reflecting calls' actual usage. No dollar savings or
latency advantage is asserted. Compare medians within each case; concurrency
and shared service load confound wall time. Off runs after auto, not randomized.

## Live evidence

Measured on 2026-11-16 using the default cheap model, low effort,
concurrency 3. This checkout is under `~/.oi-agent/worktrees`, which the macOS
sandbox deliberately hides. The initial confined attempt failed both scenarios
before any model calls (`MODULE_NOT_FOUND` for the hidden launcher). Live runs
therefore used `OI_E2E_CONFINE=0`: fixture/config/session isolation still applies,
but **OS confinement and hiding home instructions were not verified**. This is
an environment limitation, not a proposed runtime fix. Run from a normal source
checkout for a confined confirmation.

During development, two 24-sample batches exposed oracle issues: a last-delivery
report can be terse even after a complete earlier summary, and braces in
reported shell commands must not be mistaken for the summary JSON. We now keep
all parent reports and schema-check summary code blocks separately. Unit tests
reject swapped counts/backends, incomplete or malformed reports, modified
verification scripts and loss of the dirty price. These development scores are
not treated as runtime failure rates. Raw artifacts remain at
`/tmp/oi-delegation-quality-1421` and `/tmp/oi-delegation-quality-1421-final`.

Final focused run: **2 scenarios passed, 0 skipped; 24/24 samples completed,
24/24 evidence checks and choice scores passed; 0 retries**. Each case/policy
ran three times. Auto made no delegate calls on the nine edit/dirty/warm
samples, and exactly two overlapping tasks in each investigation sample.
Off made zero delegate calls. All linked tasks were delivered.

| Case                       | Auto completion / choice | Off completion | Auto / off median seconds | Auto / off median workload tokens |
| -------------------------- | ------------------------ | -------------- | ------------------------- | --------------------------------- |
| quick-edit                 | 3/3 / 3/3                | 3/3            | 10.71 / 10.07             | 11324 / 7908                      |
| independent-investigations | 3/3 / 3/3                | 3/3            | 35.55 / 17.17             | 66241 / 17651                     |
| dirty-dependency           | 3/3 / 3/3                | 3/3            | 11.98 / 10.45             | 12230 / 8436                      |
| warm-dependencies          | 3/3 / 3/3                | 3/3            | 7.57 / 8.13               | 5526 / 3606                       |

The final batch used 431,193 workload tokens across 111 agent model calls,
and took 131.03 seconds. Investigation auto used about 3.75× the median tokens
and 2.07× the wall time of off. The parent sometimes also executed the same
checks while its tasks ran: passing the split-choice hypothesis does **not**
prove the split was worthwhile. Even nondelegating auto cases had larger
context than off. Do not infer dollar costs or general savings from this sample.

Representative span evidence (from the persisted result rows):

- Dirty dependency, session `01a1e667-2f36-7830-bf61-f77449ce479b`, tool span
  `47a25577f4c15618`: `node verify.cjs dirty` → `VERIFIED:dirty`, exit 0.
  The independent harness oracle also checked cents=725 and currency=EUR,
  an unchanged verification script and no commit of the user's dirty work.
- Investigation, parent `01a1e667-2ee1-7367-b4c3-4fa81b9af767`, tool span
  `1e0f117984494b2a`: Python parsed both logs, filtered status 503 and counted
  backends, producing `east.json: errors=100, 503_backends={'east-cache': 100}`
  and `west.json: errors=75, 503_backends={'west-cache': 75}`, exit 0.
  Parent trace `01a1e6672f24dd177d1717c2fb4496c8` reported the same
  associations in its consolidated JSON. Its two tasks were linked by spans
  `a3b294f60750ccbb` and `b6ff11a5d5aa52be`; their intervals overlapped.

Full final rows (including tool inputs/outputs, report texts and IDs):
`/tmp/oi-delegation-quality-1421-verified/mwjtef0k-unprescribed-delegation-quality-{auto,off}.json`.
A final offline re-score of these 24 rows also passed after tightening marker
matching to a complete output line (reading the verification script is not
proof of executing it).

Verification accounting: one confined launch attempt failed both scenarios
before model calls; three development/final live batches each completed 24
samples (72 total), with the **last** batch using the final report oracle.
The first two batches failed the development oracles described above. Focused
replay: 2 skipped, both `needs live models`, as intended. Focused unit tests:
8 passed. Full unit/e2e/scored suites and `pnpm dev` were not run, per scope.
No cassette applies to this live-only experiment.

**Decision left open:** should auto prefer doing modest independent analyses
itself, or prioritize keeping the conversation free despite startup/context
cost? These samples support the escape hatch and restraint on small/dirty/warm
work; they do not settle the default or justify a runtime change. More
substantial investigations and a confined run are useful next samples.
No runtime or default-policy change is included. A task-specific PR is deferred
until consolidation onto the user's existing `try/delegation` branch.
