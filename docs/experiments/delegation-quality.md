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

### Worktree development run (OS confinement disabled)

Measured on 2026-11-16 using the default cheap model, low effort,
concurrency 3. The development checkout was under `~/.oi-agent/worktrees`, which the macOS
sandbox deliberately hides. The initial confined attempt failed both scenarios
before any model calls (`MODULE_NOT_FOUND` for the hidden launcher). Live runs
therefore used `OI_E2E_CONFINE=0`: fixture/config/session isolation still applies,
but **this batch did not verify OS confinement or hiding home instructions**.
This was an environment limitation, not a proposed runtime fix. The later
main-checkout run below exercised confinement without this override.

During development, two 24-sample batches exposed oracle issues: a last-delivery
report can be terse even after a complete earlier summary, and braces in
reported shell commands must not be mistaken for the summary JSON. We now keep
all parent reports and schema-check summary code blocks separately. Unit tests
reject swapped counts/backends, incomplete or malformed reports, modified
verification scripts and loss of the dirty price. These development scores are
not treated as runtime failure rates. Raw artifacts remain at
`/tmp/oi-delegation-quality-1421` and `/tmp/oi-delegation-quality-1421-final`.

Final worktree development run: **2 scenarios passed, 0 skipped; 24/24 samples completed,
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

That worktree batch used 431,193 workload tokens across 111 agent model calls,
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

Full worktree rows (including tool inputs/outputs, report texts and IDs):
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

### Confined main-checkout follow-up: split hypothesis failed

After integration as `1f12dbe`, the main checkout at
`/Users/tony/repos/oi-agent` ran the documented command with
`OI_E2E_CONCURRENCY=3`, default cheap model/low effort and **no
`OI_E2E_CONFINE=0` override** (job `5cac2510`, 2026-11-16).

**Result: 1 scenario failed (auto), 1 passed (off), 0 skipped; 24/24 samples
completed and 24/24 evidence checks passed; 0 retries.** All task linkage and
delivery checks passed. The sole failure was auto's independent-investigation
choice rate: **1/3**, below the unchanged **2/3** bar. Auto again delegated
none of the nine quick-edit/dirty/warm samples; off delegated nothing.

| Case                       | Auto completion / evidence / choice | Off completion / evidence / choice | Auto / off median seconds | Auto / off median workload tokens |
| -------------------------- | ----------------------------------- | ---------------------------------- | ------------------------- | --------------------------------- |
| quick-edit                 | 3/3 / 3/3 / 3/3                     | 3/3 / 3/3 / 3/3                    | 11.62 / 10.85             | 12260 / 9480                      |
| independent-investigations | 3/3 / 3/3 / **1/3**                 | 3/3 / 3/3 / 3/3                    | 29.94 / 20.54             | 24082 / 10671                     |
| dirty-dependency           | 3/3 / 3/3 / 3/3                     | 3/3 / 3/3 / 3/3                    | 12.67 / 12.29             | 12774 / 13006                     |
| warm-dependencies          | 3/3 / 3/3 / 3/3                     | 3/3 / 3/3 / 3/3                    | 6.19 / 6.39               | 5768 / 3868                       |

The batch took **117.50 seconds**, using **310,698 workload tokens across
92 agent model calls**: auto 187,584 tokens / 53 calls, off 123,114 tokens /
39 calls. For investigations, the auto-policy median was **2.26× tokens and
1.46× latency** versus off. Unlike the earlier all-split worktree batch,
this auto group mixes two direct executions with one split execution; those
ratios compare policies, not three delegated executions against three direct
ones. The single split sample used 56,792 tokens, 13 calls and 33.71 seconds;
the direct auto samples used 14,351 / 24,082 tokens, 4 / 6 calls and
19.65 / 29.94 seconds. These are three observations, not a causal estimate of
delegation overhead or evidence that confinement changed the choices.

The persisted evidence confirms the failed hypothesis, not a deterministic
oracle bug:

- Investigation sample 0, parent `01a1e66b-6ace-730c-bccf-780b67accd5e`,
  made **zero** delegate calls. Tool span `07c611f17b722b5f` ran a `jq`
  filter/count on each file, returning
  `east.json {"errors":100,"backends":["east-cache"]}` and
  `west.json {"errors":75,"backends":["west-cache"]}`, exit 0.
  Parent trace `01a1e66b6b0ca7c2cb6a1045ed800209` reported the matching
  consolidated JSON. Correct, evidenced work still failed the split metric.
- Sample 1 made **two** delegate calls, spans `50a5e93c550e4528` and
  `12b572e901e9986d`. The child turn intervals overlapped
  (start/end epoch milliseconds: 1794867187572–1794867205178 and
  1794867187571–1794867203432), and both results were delivered. This is the
  one passing split sample. Parent span `26fb503fee567611` also computed both
  counts with Python: the parent duplicated checks while the children worked.
- Sample 2, parent `01a1e66b-f153-7aaa-b1d2-bd5ee31bce69`, likewise made
  **zero** delegate calls. Tool span `ab26c6fa660613b1` emitted the correct
  combined JSON, exit 0; parent trace `01a1e66bf189ad391f497d6384cd47f2`
  reported the same counts/backends. It too failed only the split metric.

The choice oracle requires at least two delegate calls with overlapping child
turns. The rows show delegate counts **0, 2, 0** and overlap **false, true,
false**, so 1/3 is the correct calculation. No prompt, assertion, threshold or
runtime change was made in response to this result, and no model rerun was
needed to inspect it.

Source log:
`/Users/tony/.oi-agent/jobs/01a1e601-db25-7c7d-90d7-b74b30d3a53a/5cac2510/log`.
Full persisted rows:
`$TMPDIR/oi-e2e-results/mwjtkd5n-unprescribed-delegation-quality-{auto,off}.json`
(on this host, TMPDIR is
`/var/folders/7w/4nkdbvy90tq5dd4yc45lpbqc0000gn/T/`).
Including this follow-up, four live development/verification batches completed
**96 samples**; the earlier failed confined launch made no model calls.
The confined follow-up is additional evidence, **not** a replacement for the
historical worktree scores or a passing stability claim.

## Policy judgment (no gate or default change)

A hard split requirement for these modest investigations is **not justified
as a task-quality/release gate by the current evidence**. Independence makes
parallel work possible, not necessarily valuable. The two direct auto samples
completed correctly with supported reports, and the split sample duplicated
parent work and cost more than either direct auto sample. The earlier passing
split batch was also more costly than off. We did not measure the benefit of
keeping an interactive conversation available while work runs; the headless
experiment cannot decide that tradeoff.

The split rate remains a useful **experimental policy-conformance metric**:
it honestly shows that the proposed split hypothesis was not stable in this
confined batch. The existing scored assertion remains unchanged, and the run
is reported as failed. Reclassifying that hypothesis as an observational score
rather than a hard gate would be a separate, explicitly justified design
change—not a fix to make this sample green. Correctness, evidence, preservation
of user work and avoidance of unnecessary local-work delegation remain
independent checks.

**Decision left open:** should auto prefer doing modest independent analyses
itself, or prioritize keeping the conversation free despite startup/context
cost? These samples support the escape hatch and restraint on small/dirty/warm
work; they do not settle the default or justify a runtime change. Larger tasks
and an interactive responsiveness measurement would better test the benefit
of splitting. The confined follow-up closes the earlier environment-verification
gap, but not the policy question.

No runtime, prompt, assertion or default-policy change is included. The initial
implementation was consolidated as `1f12dbe`; this documentation follow-up's PR
is deferred pending consolidation onto the user's existing `try/delegation`
branch.
