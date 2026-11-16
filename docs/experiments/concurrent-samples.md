# Isolated concurrent steering samples

Measured on the same macOS arm64 machine, 2026-11-15. Default models:
`chatgpt/gpt-5.6-luna` for the agent and the existing default steering judge.
No prompts, models or pass bars were changed. The current experiment has
15 cases, not the 12 in the original proposal: 6 durable and 9 one-off.
Three repetitions mean 45 independent two-turn jobs.

| Run                              | Workers | Scored scenario wall time | Durable learned | One-off learned |
| -------------------------------- | ------- | ------------------------- | --------------- | --------------- |
| Original shared-sandbox baseline | 1       | 759.190 s                 | 18/18           | 1/27            |
| Isolated run 1                   | 4       | 198.340 s                 | 18/18           | 4/27            |
| Isolated run 2                   | 4       | 195.947 s                 | 18/18           | 4/27            |
| Isolated run 3 (full suite)      | 4       | 188.017 s                 | 18/18           | 2/27            |

All scored runs passed the unchanged bars (durable ≥ 2/3, one-off ≤ 1/6).
The new runs took 24.8–26.1% of baseline wall time (3.83–4.04× faster).
This is an observed comparison, not a claim of deterministic model latency
or identical model judgments. No availability retries occurred in these
three scored runs. The baseline reused a workspace across cases; new runs
intentionally remove that source of cross-case contamination.

Each new run wrote exactly 45 JSON rows. Rows identify case, repetition,
learned outcome, actual evaluator filenames, producer inferred from each
saved evaluator's `origin`, retries, elapsed time, sandbox and session IDs.
The result table and Phoenix metadata use those same rows. Queried the live
Phoenix OTLP endpoint and matched all 45 rows’ case, sample, learned and retry
fields against each of the three JSON artifacts. No evaluator is
counted more than once within a case; an outcome is whether any were created,
not the number created. Files stay in each sample sandbox until cleanup.

The deterministic `samples.e2e.ts` regression forces concurrency 1, writes
rules and evaluator files, then proves neither the next case nor a retry can
see them. It runs the real CLI's `where` command against each child config.
It failed without the implementation (`s.samples is not a function`) and
passed three times with it, as well as in the full live suite. Worker unit
tests cover bounded overlap, stable return order and draining in-flight work
after failure. A separate scenario covers retry exhaustion, non-retryable
errors and refusing Rex in sample mode.

## Other observed failures

The baseline's unrelated product-bug scenario failed on an absent detector
verdict. During concurrent run 1, that scenario passed but the unchanged
configured-steering-model scenario created two evaluators where it expected
one. Both passed in the final full live suite. These model-dependent failures
were not fixed or hidden by changing assertions in this work.

## Verification

- `pnpm check`: passed.
- `pnpm test`: 174 passed, including 3 new worker tests.
- Full live `pnpm e2e`: 51 passed; 4 pending web-tool scenarios skipped.
- Full `OI_E2E_MODELS=replay pnpm e2e`: 46 passed; 9 skipped (4 pending web
  scenarios and 5 live-only scenarios: scored steering, isolation, sandbox
  confinement and the two real TypeSafe scenarios).
- Changed prompts/model calls: none. The scored scenario remains live-only;
  the new harness regression uses no models, so no cassette was changed.

The separate retry-exhaustion scenario was added after the full-suite runs;
its three focused live runs are reported in the PR. It is live-only because
isolated sample mode deliberately excludes the recording/replay proxy.
