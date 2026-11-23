# oi-agent

## 0.15.0

### Minor Changes

- [#99](https://github.com/cephalization/oi-agent/pull/99) [`75deb38`](https://github.com/cephalization/oi-agent/commit/75deb384810f38cfcb447848fedb1121ffa2e97e) Thanks [@cephalization](https://github.com/cephalization)! - Use Gemini 4 Hydrogen, Neon, and Carbon with `oi setup`, `/model`, or `-m google/<model>`. Sign in with an API key via `oi auth login google`, or set `GOOGLE_API_KEY` or `GEMINI_API_KEY`. Sessions preserve Gemini's signed reasoning through tool calls and resume.

## 0.14.0

### Minor Changes

- [#97](https://github.com/cephalization/oi-agent/pull/97) [`7af32e4`](https://github.com/cephalization/oi-agent/commit/7af32e42af1b491ff550cd5667d4a9b4475f6fec) Thanks [@cephalization](https://github.com/cephalization)! - Show provider-reported LLM session cost in the terminal status bar, separately from decision cost. Costs survive resume and appear in shared sessions. If some calls do not report a charge, the status bar marks the subtotal as partial instead of treating those calls as free.

### Patch Changes

- [#96](https://github.com/cephalization/oi-agent/pull/96) [`0d3f239`](https://github.com/cephalization/oi-agent/commit/0d3f239ebd709b5077a02536d930b3f79ec22370) Thanks [@cephalization](https://github.com/cephalization)! - Keep typing in the prompt composer when text arrives in the same terminal read as Enter or Escape.

## 0.13.1

### Patch Changes

- [#93](https://github.com/cephalization/oi-agent/pull/93) [`fdcec50`](https://github.com/cephalization/oi-agent/commit/fdcec501c83d93564346f665bde9a4bcc078343a) Thanks [@cephalization](https://github.com/cephalization)! - Fix dragging macOS screenshots into the terminal when their filenames contain a narrow no-break space. Pressing Enter immediately after a drop now sends the image, even without a text prompt. If a recognized drop fails to attach, oi shows the error and keeps the draft instead of sending it without the image.

## 0.13.0

### Minor Changes

- [#90](https://github.com/cephalization/oi-agent/pull/90) [`d41d15f`](https://github.com/cephalization/oi-agent/commit/d41d15fec6d7ea3376e73c38cca4659235bea2f0) Thanks [@cephalization](https://github.com/cephalization)! - Add `/feedback` to the onboarding tips and slash menu. Draft an oi GitHub issue from a short description, with Node and platform details, then review the exact preview and approve posting with `gh`. If `gh` is unavailable, use the official issue tracker.

### Patch Changes

- [#89](https://github.com/cephalization/oi-agent/pull/89) [`fb6d9dd`](https://github.com/cephalization/oi-agent/commit/fb6d9dd2bfd50fe9fef34af8c43158f1af3b797b) Thanks [@cephalization](https://github.com/cephalization)! - Clarify the correction-model choices in setup and list higher model versions first. Move “Ask me each time” to the end of the tool approval menu without changing the default or your saved preference.

## 0.12.0

### Minor Changes

- [#84](https://github.com/cephalization/oi-agent/pull/84) [`cc29c7b`](https://github.com/cephalization/oi-agent/commit/cc29c7bbf884f4ca63d39740dcd49978aaa4c1fe) Thanks [@cephalization](https://github.com/cephalization)! - Attach images to a prompt. Drop image files (PNG, JPEG, GIF or WebP) on the terminal, press ctrl+v to paste one from the clipboard, or use `/image <path>`; what is attached is listed above the prompt and goes with your next message, and Backspace at the start of the line removes the last one. `oi run --image <file>` does the same without a terminal. Images are kept in the session, so resuming, switching provider and sharing do not depend on the original files, and someone who joined with a drive link can send images to the host. oi does not check whether a model can read images: a model that cannot says so through its provider's error, and you can switch to one that can with `/model`.

- [#85](https://github.com/cephalization/oi-agent/pull/85) [`e3da10c`](https://github.com/cephalization/oi-agent/commit/e3da10c5c44b85683c4af0b38fbe2a7e90e40e50) Thanks [@cephalization](https://github.com/cephalization)! - `/phoenix` chooses the Phoenix server, project and login while a session runs, and export switches to it at once with no restart; `oi setup` asks the same questions. oi now asks the server what it wants before saving: a Phoenix without auth needs no key, and one that asks for a login offers "Log in with your browser", where you approve oi in Phoenix and it stores a personal API key in your keychain without you seeing or pasting it. Pasting an API key still works, as does pasting the redirect address when the browser cannot reach your machine. `/phoenix` then `none` turns export off.

### Patch Changes

- [#88](https://github.com/cephalization/oi-agent/pull/88) [`fe91168`](https://github.com/cephalization/oi-agent/commit/fe91168d8742b9cfe5c7b442cb76e5b66e733ef0) Thanks [@cephalization](https://github.com/cephalization)! - Setup now ends with a quick overview of features that need no setting: attaching images, typing while oi works, `/phoenix` and `/share`. Setup and the Phoenix step use plainer wording throughout.

- [#83](https://github.com/cephalization/oi-agent/pull/83) [`46c721e`](https://github.com/cephalization/oi-agent/commit/46c721eff9f60d17cedce9bd4694503cd34481c6) Thanks [@cephalization](https://github.com/cephalization)! - A message you give to a running turn now counts as something you said for everything that reads the turn. Before, only the agent saw it: auto approvals decided later tool calls against the original prompt alone, evaluators judged a transcript without it, and a correction given mid-turn ("no, use pnpm") was never considered for learning. Now the approval decider sees it from the next tool call on, evaluators see it where it was said, and steering detection reads each mid-turn message on its own.

## 0.11.1

### Patch Changes

- [#81](https://github.com/cephalization/oi-agent/pull/81) [`855ef68`](https://github.com/cephalization/oi-agent/commit/855ef683790e1e760845da31c5c58b29d5adbe15) Thanks [@cephalization](https://github.com/cephalization)! - Stop describing delegation as experimental in the README and the bundled guide. The `"delegation": "off"` setting is unchanged.

## 0.11.0

### Minor Changes

- [#63](https://github.com/cephalization/oi-agent/pull/63) [`5aae11e`](https://github.com/cephalization/oi-agent/commit/5aae11effbf29f6b2469c0801f628bb029f50f22) Thanks [@cephalization](https://github.com/cephalization)! - The agent can now search the web on Anthropic, OpenAI and ChatGPT models, and read a page on Anthropic models, using the provider's own web tools. They run on the provider's servers, so nothing is fetched from your machine and no approval is asked; the provider bills searches separately. Set `"web": "off"` in the config, or `OI_AGENT_WEB=off`, to stop offering them. Other OpenAI-compatible servers are unchanged.

### Patch Changes

- [#78](https://github.com/cephalization/oi-agent/pull/78) [`6e47297`](https://github.com/cephalization/oi-agent/commit/6e47297a6152938fea8917b1b493621de2166aea) Thanks [@cephalization](https://github.com/cephalization)! - Fix `oi join` crashing against hosts started on an older version. Drivers and viewers can still follow the conversation; a startup note explains when the host must be updated and restarted to publish live task status. Invalid host responses now produce descriptive errors. Protect existing and newly started task visibility without granting task control or tool approvals.

- [#76](https://github.com/cephalization/oi-agent/pull/76) [`14258ca`](https://github.com/cephalization/oi-agent/commit/14258caf64242f922301685d3562a758af62b40f) Thanks [@cephalization](https://github.com/cephalization)! - Exit joined chats with a clear host-disconnected message when sharing ends or the transport stops responding. Close the host event stream before stopping its tunnel, and cancel pending prompts on disconnect instead of hanging or reporting an unhandled fetch error. `oi join` now returns to the shell after a disconnect over a tunnel, where it used to wait on a tunnel process that would not stop. Joining a host too old to publish live status keeps working while that host is idle.

- [#77](https://github.com/cephalization/oi-agent/pull/77) [`e5b3af6`](https://github.com/cephalization/oi-agent/commit/e5b3af6d089e557ef728f3c7acba9a6a88dbdf04) Thanks [@cephalization](https://github.com/cephalization)! - Make the README a shorter introduction and consolidate detailed usage and contributor documentation in the bundled guide. Keep links between bundled documents working offline.

## 0.10.1

### Patch Changes

- [#74](https://github.com/cephalization/oi-agent/pull/74) [`fed5ad7`](https://github.com/cephalization/oi-agent/commit/fed5ad7c34b214517ffe31a867c74b5a901fd6d8) Thanks [@cephalization](https://github.com/cephalization)! - Shared-session drivers can steer a running turn or use Ctrl+T to queue the next turn, just like the host. Drivers and read-only viewers now see all participants' pending messages with sender names, background commands, task progress and waiting results. Tool approvals remain with the host, and viewer links remain read-only.

## 0.10.0

### Minor Changes

- [#70](https://github.com/cephalization/oi-agent/pull/70) [`7664fdd`](https://github.com/cephalization/oi-agent/commit/7664fdd2fe3be40d1d0e0256b8f10d092cfcf3bb) Thanks [@cephalization](https://github.com/cephalization)! - Open `/tasks` as a keyboard picker to view any task's conversation. Running and approval-waiting tasks appear first, newest-created first within each group; completed and stopped tasks remain available. Direct `/attach <id>` and `/detach` still work.

### Patch Changes

- [#66](https://github.com/cephalization/oi-agent/pull/66) [`a0531ae`](https://github.com/cephalization/oi-agent/commit/a0531aea4b966b14ff0c2f5f18bc11957d978e49) Thanks [@cephalization](https://github.com/cephalization)! - Exclude time waiting for tool approval (including automatic safety decisions) from displayed tool durations and tool execution metrics. Denied calls count as zero execution time; turn wall time and full tool span latency still include approval. Historical spans without an execution boundary retain their original inclusive timing.

- [#65](https://github.com/cephalization/oi-agent/pull/65) [`af95dcd`](https://github.com/cephalization/oi-agent/commit/af95dcd3931d6f450125f0ec1b999fd196d934f6) Thanks [@cephalization](https://github.com/cephalization)! - Fix reasoning effort cycling for newer ChatGPT models, including GPT-6. Use the provider's advertised effort levels for selection and requests, and preserve xhigh and max as distinct levels.

- [#67](https://github.com/cephalization/oi-agent/pull/67) [`f194e64`](https://github.com/cephalization/oi-agent/commit/f194e6454e1115d4913b9050a9662df8d5a075f5) Thanks [@cephalization](https://github.com/cephalization)! - Make Shift+Enter insert a newline, show prompt hotkeys, and make Escape stop the current turn and all background tasks without sending queued prompts. Restore the latest queued prompt for editing, with earlier prompts available through Up/Down history.

- [#69](https://github.com/cephalization/oi-agent/pull/69) [`2a8d31a`](https://github.com/cephalization/oi-agent/commit/2a8d31af6d4a6cd4fac6d126553f900b46ca3d78) Thanks [@cephalization](https://github.com/cephalization)! - Ask the agent to give a brief consolidated summary when a batch of background commands and delegated tasks finishes, including earlier results, failures, limitations and remaining decisions or next steps, rather than reporting only the last result.

## 0.9.0

### Minor Changes

- [#57](https://github.com/cephalization/oi-agent/pull/57) [`273c225`](https://github.com/cephalization/oi-agent/commit/273c225fb55378e3295d3d7100a194a4b797dfbc) Thanks [@cephalization](https://github.com/cephalization)! - Long commands no longer die at the tool timeout. A `bash` command that is still running after its time limit keeps going as a background job, and the agent can start one that way on purpose (test suites, builds, servers). You can keep talking while it runs: the status line counts running jobs, and when one finishes its result is delivered to the agent, which picks the work back up. Jobs survive `/reload` and quitting oi; results that arrive while you are away are delivered when you reopen the session. `oi run` waits for the jobs it started (`--no-wait` to skip that).

- [#57](https://github.com/cephalization/oi-agent/pull/57) [`271df99`](https://github.com/cephalization/oi-agent/commit/271df990f00fb16345a6c4d82260f1ac7fa63411) Thanks [@cephalization](https://github.com/cephalization)! - oi now delegates by default. The conversation stays open for thinking and planning while subagents do the work: the agent writes a brief and hands it to another oi agent with its own session, and for anything that changes files its own git worktree and branch, so tasks run side by side without colliding with each other or your checkout.
  
  - Running tasks and background commands are listed above the status line, with what each is doing.
  - Results come back by themselves. If you are typing, they wait (`✉ 1 result waiting`) until you send or clear your prompt; `/inbox` delivers them now. Several arrive as one digest.
  - A tool call a subagent needs approved is asked in your terminal, labelled with the task.
  - `/tasks` lists them, `/attach <task>` opens one to watch and type to, `/detach` returns. You can also ask the agent to steer or cancel a task.
  - Tasks keep running when you quit or `/reload`; what finished meanwhile is delivered when you return.
  - A task that ends without changing anything removes its worktree and branch; one with work in it keeps them until you merge or remove them. A follow-up message to a finished task continues it where it was.
  - `oi -s <task session>` opens a task directly; tool calls it needs approved are asked there too.
  - New config: `cheap_model` (the model for mechanical tasks), `max_tasks` (how many run at once, default 4), and `"delegation": "off"` to keep all work in the conversation.

- [#60](https://github.com/cephalization/oi-agent/pull/60) [`fd927a6`](https://github.com/cephalization/oi-agent/commit/fd927a6c9db610a03f594b8ae1b84e41bfcedc0f) Thanks [@cephalization](https://github.com/cephalization)! - `/metrics` shows where a session's time went, and `oi metrics [session]` prints the same from the shell (`--json` for all the numbers). Each turn is split into model time and tool time; tool time is grouped by what ran (`pnpm e2e`, `git commit`, `read_file`), the slowest tool calls are listed, and evaluator and learning time is reported apart from the turns. Delegated tasks are listed with their own totals. Everything is computed from the start and end times the span files already hold, so it works on old sessions too.

- [#51](https://github.com/cephalization/oi-agent/pull/51) [`7a5879a`](https://github.com/cephalization/oi-agent/commit/7a5879ac21689abf6614935b98a8104578f28536) Thanks [@cephalization](https://github.com/cephalization)! - `/model` now saves the model you pick as the default, so new sessions start on it instead of going back to the one in your config. Use `/model --temp <model>` to switch only for the running process. Resumed sessions still continue on the model they last used.

- [#57](https://github.com/cephalization/oi-agent/pull/57) [`54f307e`](https://github.com/cephalization/oi-agent/commit/54f307ec66efdc367e135e5c3a9069b780e47ab3) Thanks [@cephalization](https://github.com/cephalization)! - Evaluators understand work that finishes later. An LLM evaluator sees which background commands and tasks a turn started and which results it was given, so reporting on earlier work is not mistaken for starting it again. A new opt-in, `wait_for_background: true`, is for checks that depend on the outcome ("the tests it started must pass"): the turn that starts the work is marked `pending`, with no failure feedback and nothing learned from it, and is judged once the results have been delivered, polled with `job_status`, or the work was cancelled. Pending results are not counted as passes. Checks without the option still run at once, which is what a rule about starting work wants.

- [#61](https://github.com/cephalization/oi-agent/pull/61) [`cb8851a`](https://github.com/cephalization/oi-agent/commit/cb8851a7e826f0f1f42c3c7d5b8c276ebb81836e) Thanks [@cephalization](https://github.com/cephalization)! - The terminal now says what Enter will do, and lets you choose. Under the prompt: `enter starts a new turn` when the conversation is idle, including while tasks and background commands are still running. While a turn runs, Enter **steers** it: the agent reads your message before its next step, in the same turn, instead of after it has finished. Press ctrl+t to switch to **queueing** the message for the next turn, and again to switch back. Messages that are waiting are listed above the status line, a steering message is shown in the transcript where the agent was given it, and if a turn ends before it could be steered the message runs as the next turn and the terminal says so. Queued messages are kept on disk, so quitting does not lose them.

### Patch Changes

- [#59](https://github.com/cephalization/oi-agent/pull/59) [`595f68c`](https://github.com/cephalization/oi-agent/commit/595f68ca225b24a84cf06886bffcac4b68302496) Thanks [@cephalization](https://github.com/cephalization)! - Fix replies being cut short, or missing, in a terminal attached to a task (`/attach`, `oi -s <task>`). Text a subagent wrote between two looks at its files was dropped, so a reply could show as its first few characters.

- [#58](https://github.com/cephalization/oi-agent/pull/58) [`a610ec1`](https://github.com/cephalization/oi-agent/commit/a610ec1dbe96baab5192418713bd8743ed3e2ce7) Thanks [@cephalization](https://github.com/cephalization)! - `LLM` spans now say who served a call and how it was paid for. `llm.provider` is the vendor (`openai` for both an OpenAI API key and the ChatGPT plan sign-in, where it used to say `chatgpt`), oi's own provider id stays in `metadata.oi_agent.provider`, and a new `metadata.oi_agent.billing` is `plan` for ChatGPT-plan calls and `api` otherwise, so plan usage can be told apart from per-token spend in Phoenix. An OpenAI-compatible provider entry can declare a `vendor` (for example `"groq"`). Evaluator judge spans no longer put a provider id in `llm.system`.

- [#64](https://github.com/cephalization/oi-agent/pull/64) [`3fc6544`](https://github.com/cephalization/oi-agent/commit/3fc654404ce6f7bb5a7daa63deb7cd33036ec804) Thanks [@cephalization](https://github.com/cephalization)! - Fixes found before the release:
  
  - A message queued for the next turn no longer starts after you have left: quitting, `/reload`, `/new` and `/resume` leave it in the session, and it runs when the session is next opened. Before, a message the engine had already picked up could start a turn with nobody at the terminal.
  - `oi -c` and `oi metrics` with no session now mean the session you last worked in. They used to take the newest session folder, which was often a delegated task's session or one opened and closed without a prompt.
  - During `/compact` and `/handoff` the line under the prompt says Enter queues: those read nothing said to them, so a message sent then was shown as steering and never read.

## 0.8.0

### Minor Changes

- [#44](https://github.com/cephalization/oi-agent/pull/44) [`ab3a6ca`](https://github.com/cephalization/oi-agent/commit/ab3a6cad76b05290b569d99ceeae99ab7551cc69) Thanks [@cephalization](https://github.com/cephalization)! - Evaluators now say when they apply. `create_eval` and checks learned from your corrections record a trigger (file changes, a Git commit, a particular tool, or every turn), shown when the check is saved. A turn the check does not apply to is recorded as `skipped`, without a judge call and without feedback or a learned rule. Commits and file changes are detected from what Git and the files actually did, so a commit made from bash counts and a failed one does not. When the evidence is unclear the check runs. A failed check is rechecked on the next turn even if that turn makes no new commit, so opening the missing PR resolves it. Existing checks keep running on every turn.

### Patch Changes

- [#43](https://github.com/cephalization/oi-agent/pull/43) [`8a6853f`](https://github.com/cephalization/oi-agent/commit/8a6853f5da61d5c1d19b85b36e2245d108e16443) Thanks [@cephalization](https://github.com/cephalization)! - Auto approval asks less often: every decision-model threshold is now 0.5 (each risk must be below 0.5, and the call must be requested with probability above 0.5). Hard rules for destructive deletes, force pushes, sudo, discarded work and writes outside the workspace still always ask.

- [#45](https://github.com/cephalization/oi-agent/pull/45) [`5d8e729`](https://github.com/cephalization/oi-agent/commit/5d8e729fd8887ca8de66c2ce4acb872be53441a9) Thanks [@cephalization](https://github.com/cephalization)! - The status bar now shows how full the context is (the latest model request and its reply, for example `140k context`) instead of every model call added up, which counted cached history again on each call and included evaluators. `/session` still reports the running total.

## 0.7.0

### Minor Changes

- [#38](https://github.com/cephalization/oi-agent/pull/38) [`9313fd9`](https://github.com/cephalization/oi-agent/commit/9313fd9097b666aecc56ffc9d8aa59c6d63466f6) Thanks [@cephalization](https://github.com/cephalization)! - Passing evaluators no longer print a line each after every turn: the status bar shows how many passed (`◆ 3 evals passed`), and only failures are printed in full. The new `/verdicts` command shows every verdict on the last reviewed turn, with its label, score, explanation and metadata.

## 0.6.0

### Minor Changes

- [#30](https://github.com/cephalization/oi-agent/pull/30) [`c58479d`](https://github.com/cephalization/oi-agent/commit/c58479d280e4606b0b26b72acf4d51ecd504836f) Thanks [@cephalization](https://github.com/cephalization)! - Report working, approval-blocked, completed and failed states to terminals that support OSC 7501, including Rex. Interactive sessions acknowledge results on the next keypress and clear status on exit; `oi run` leaves its completion status visible. Status messages are secret-scrubbed, and redirected stdout is unchanged.

### Patch Changes

- [#37](https://github.com/cephalization/oi-agent/pull/37) [`efe5932`](https://github.com/cephalization/oi-agent/commit/efe5932e3f567ab07f950569abbd598113070961) Thanks [@cephalization](https://github.com/cephalization)! - Token counts in the status bar move up a unit instead of growing: a long session shows `6.0M tokens`, not `6000.5k tokens`.

- [#36](https://github.com/cephalization/oi-agent/pull/36) [`162df25`](https://github.com/cephalization/oi-agent/commit/162df2547df8293157786f5bf88b179f3d110802) Thanks [@cephalization](https://github.com/cephalization)! - The approval mode you pick with Tab, `/auto` or `/yolo` is saved to the config file, so oi starts in it next time instead of going back to ask.

## 0.5.0

### Minor Changes

- [#26](https://github.com/cephalization/oi-agent/pull/26) [`1eb7201`](https://github.com/cephalization/oi-agent/commit/1eb7201c6f3de1ebea60eefcc07d584aada40ce9) Thanks [@cephalization](https://github.com/cephalization)! - Add `/compact [focus]` to summarize a thread's context without changing its historical spans. Compaction is traced with explicit checkpoint provenance, survives resume from disk or Phoenix, and retains the original context if summarization fails or is interrupted.

- [#29](https://github.com/cephalization/oi-agent/pull/29) [`25130bd`](https://github.com/cephalization/oi-agent/commit/25130bd3e2297828cda8dcf7f16520a60fc9fdde) Thanks [@cephalization](https://github.com/cephalization)! - Call OpenAI and ChatGPT models over a WebSocket so the prompt cache is reused between calls. Over plain HTTP most calls on a ChatGPT plan read nothing from the cache; with one connection per conversation, calls after the first read most of the prompt from it, which lowers plan usage and latency in long sessions. oi falls back to HTTP when a socket cannot be opened, and `OI_AGENT_OPENAI_TRANSPORT=http` turns the WebSocket off. `LLM` spans now record the transport as `network.protocol.name`, and cache writes reported by OpenAI as `llm.token_count.prompt_details.cache_write`.

- [#26](https://github.com/cephalization/oi-agent/pull/26) [`62e82b1`](https://github.com/cephalization/oi-agent/commit/62e82b1878c2931f20bc35ed1bb494cc7a9c833d) Thanks [@cephalization](https://github.com/cephalization)! - Add `/handoff <query>` to open a new thread with a generated working brief and your exact query. The original thread is preserved, and the new thread carries its own durable context and provenance for restart and Phoenix restore. Interrupted destination turns are not automatically retried.

- [#26](https://github.com/cephalization/oi-agent/pull/26) [`2c1a552`](https://github.com/cephalization/oi-agent/commit/2c1a552ca4c15de380f42a944cb10d73387289d9) Thanks [@cephalization](https://github.com/cephalization)! - Keep the current session ID visible in the status bar, including after a handoff or session switch. Add `/session` to print the full copyable ID and resume command.

### Patch Changes

- [#27](https://github.com/cephalization/oi-agent/pull/27) [`a80b45c`](https://github.com/cephalization/oi-agent/commit/a80b45ce51ce313d9b147cac36f78970b25569f0) Thanks [@cephalization](https://github.com/cephalization)! - Make session switches visibly distinct: `/handoff`, `/new`, and `/resume` start a fresh viewport with the destination banner and status bar. Previous output remains available in terminal scrollback.

- [#26](https://github.com/cephalization/oi-agent/pull/26) [`a14a767`](https://github.com/cephalization/oi-agent/commit/a14a767e9875e00545351babc24c675ab0133876) Thanks [@cephalization](https://github.com/cephalization)! - Repair handoffs interrupted between destination header creation and seed completion, using the source's durable spans without rerunning summarization. Initialize pending handoffs before ordinary queued or inbox prompts so the original query and brief cannot be bypassed.

## 0.4.0

### Minor Changes

- [#25](https://github.com/cephalization/oi-agent/pull/25) [`c922787`](https://github.com/cephalization/oi-agent/commit/c9227876616158e4570a788592fc4729f4d917c3) Thanks [@cephalization](https://github.com/cephalization)! - Configure which provider and model learns from your corrections, including ChatGPT and OpenAI-compatible servers without an Anthropic key. Setup offers the choice.
  
  Add System One-compatible decision models (TypeSafe Jev) for auto-mode tool approvals and cheap steering screens. Auto mode approves only confident, low-risk calls and asks about the rest; missing keys, invalid answers and service failures fall back to asking. Configure the endpoint and model independently of chat providers, store its key with `oi auth login typesafe` or `/provider`, and inspect each call as a `DECISION` span with separate usage.
  
  Auto approvals distinguish requested read-only service queries and normal authentication from remote writes and secret exposure. When auto mode asks, its prompt shows the failed thresholds. Approving one call cannot switch auto mode to yolo; that mode change must be selected separately.
  
  Steering distinguishes product bug reports from preferences about the coding agent's working habits. Reports about the harness's approval UI must not become rules to bypass approvals. A steering writer can veto a decision screen's false positive.

- [#19](https://github.com/cephalization/oi-agent/pull/19) [`59279a1`](https://github.com/cephalization/oi-agent/commit/59279a11961190625d4a6745a35946d1b15ba395) Thanks [@cephalization](https://github.com/cephalization)! - `/reload` restarts oi on its current code without leaving the session. The `oi` command is now a small launcher that runs the CLI and starts it again when asked to, carrying over the session, model, effort and approval mode. Before restarting, it checks that the new code loads, and keeps the current build running if it does not. If code started by a reload fails to start or crashes, oi falls back to the bundled build on the same session and says why, and a later `/reload` tries the fixed code again. If oi dies abnormally, the launcher restores the terminal's settings. Run from a checkout with `bin/oi`, this means edits to oi's own sources take effect in place. Also new: `--effort <level>`, and `--check`, which loads every module and exits.

- [#18](https://github.com/cephalization/oi-agent/pull/18) [`ce8b4dc`](https://github.com/cephalization/oi-agent/commit/ce8b4dcc4324b2e1ffe05158b1a9afb736131047) Thanks [@cephalization](https://github.com/cephalization)! - Switching to a session with `/resume`, or opening one with `oi resume` or `oi -s`, now continues on the model, provider and effort that session last used, read from its spans. An explicit `-m` still wins. If the session's model is no longer available (its provider was removed, or there is no key), oi stays on the current model and says so. New sessions keep the current model.

- [#21](https://github.com/cephalization/oi-agent/pull/21) [`268688c`](https://github.com/cephalization/oi-agent/commit/268688c06156d7da034e868ece96652c68135eff) Thanks [@cephalization](https://github.com/cephalization)! - oi learns from your corrections. After each turn a small model (the judge model, which needs an Anthropic key) reads your prompt, and when it corrects the agent in a way that applies beyond the current task, oi saves it as an evaluator, with a note under the turn and a link back to the prompt it came from. Corrections that only concern the task at hand are left alone. Turn it off with `"steering": "off"` in the config or `OI_AGENT_STEERING=off`. Also fixed: an evaluator created with `create_eval` could fail on the turn that created it, because its own definition contained the pattern it checks for.

## 0.3.0

### Minor Changes

- [#17](https://github.com/cephalization/oi-agent/pull/17) [`c8ba77d`](https://github.com/cephalization/oi-agent/commit/c8ba77d33768d40080c2487b7f39fb6c8c56d3ae) Thanks [@cephalization](https://github.com/cephalization)! - oi now follows the instruction files and skills you keep for other coding agents. At the start of a session it reads the nearest `AGENTS.md`, `AGENT.md` or `CLAUDE.md` (from the working directory up to the repository root, plus `~/.claude/CLAUDE.md` and `~/.config/AGENTS.md`). Skills in `.agents/skills/` and `.claude/skills/`, in the project or your home directory, are listed by description, and a skill is read in full only when a task calls for it. Each read shows up as a tool call in the session's spans.

- [#15](https://github.com/cephalization/oi-agent/pull/15) [`3c8cfa1`](https://github.com/cephalization/oi-agent/commit/3c8cfa1f3e0ba60f5643b46552e5625614cfefe9) Thanks [@cephalization](https://github.com/cephalization)! - - **Point model requests at a proxy:** `OPENAI_BASE_URL` now overrides the API root for the OpenAI and ChatGPT providers, as `ANTHROPIC_BASE_URL` already did for Anthropic.
  - **See pending approvals in the trace:** a tool call waiting for you to allow or deny it is now marked `awaiting_approval` on its in-flight `TOOL` span. Viewers and anything else reading the session can tell it apart from a tool that is running.
  - **A bad value in `config.json` no longer resets everything:** a value oi does not accept (a typo, or a setting from a newer version) used to make it ignore the whole file silently, so every setting went back to its default, model included. Now only that key is ignored, and oi says which one, under the banner or on stderr for `oi run`.

### Patch Changes

- [#17](https://github.com/cephalization/oi-agent/pull/17) [`5a7ea88`](https://github.com/cephalization/oi-agent/commit/5a7ea888e93096b6f538e881383b441c4ff259bd) Thanks [@cephalization](https://github.com/cephalization)! - The bash tool now says when it killed a command for running past its time limit, and how to give the command longer, instead of leaving the model to read the kill as a failure. Commands it runs see `OI_AGENT=1`, so scripts can tell they run under oi.

## 0.2.0

### Minor Changes

- [#6](https://github.com/cephalization/oi-agent/pull/6) [`6346b98`](https://github.com/cephalization/oi-agent/commit/6346b98442ffb16214de73392f20fee8f6540675) Thanks [@cephalization](https://github.com/cephalization)! - oi-agent now runs on OpenAI and OpenAI-compatible APIs, not only Anthropic's.
  
  - **Pick any provider's model:** `/model` lists every provider's models (`anthropic/claude-opus-5-5`, `openai/gpt-5.1`, `ollama/qwen3`, …), and `-m provider/model` does the same from the command line. You can switch provider in the middle of a session: the conversation carries over as text, tool calls and tool results.
  - **Manage providers with `/provider`:** a menu of Anthropic, OpenAI and OpenAI-compatible servers, each with its own options. Keys are typed into a hidden prompt and stored in the system keychain. To add a server such as Ollama, vLLM, LM Studio or OpenRouter, give it a name, a base URL, a key if it needs one, and a comma-separated list of models. Those models appear in `/model` right away, with the names and output limits the server reports. A server's models, URL and key can be changed later, or the server removed.
  - **Sign in with ChatGPT:** `/provider` → OpenAI (or `oi auth login chatgpt`) signs in with your ChatGPT plan in the browser, so you can use the plan's allowance instead of an API key. OpenAI allows this for open-source tools that run locally.
  - **Setup:** `oi setup` now starts by asking which provider to use, and `oi auth login <provider>` stores a key for any provider.
  
  Claude subscriptions are not supported, because Anthropic does not allow third-party tools to offer claude.ai login. Evaluators still judge with Claude, so they run only when an Anthropic key is set.

- [#4](https://github.com/cephalization/oi-agent/pull/4) [`6a8162d`](https://github.com/cephalization/oi-agent/commit/6a8162d607dbe8eb6868e0b013060c702327dac9) Thanks [@cephalization](https://github.com/cephalization)! - Resume any session traced to Phoenix, on any machine: `oi resume <session id>`, or paste a session URL from the Phoenix UI. A trace URL continues from that turn instead, forking the session there. The `/resume` list now includes the sessions in your Phoenix project.
  
  Sessions can also live only in Phoenix to save disk space: press Tab on one in the `/resume` list. Its local files are deleted only once Phoenix is confirmed to hold all of it. Opening it fetches it again, and leaving moves it back out. Tab again keeps it on disk.
  
  A session from another machine opens with tools asking before they run, even with `--yolo`. If your checkout differs from the one the session last ran in, oi tells you when it opens. Each turn now records its directory, git remote, commit and whether there were uncommitted changes.

- [#2](https://github.com/cephalization/oi-agent/pull/2) [`18d5377`](https://github.com/cephalization/oi-agent/commit/18d5377b2448038c3de15c3d792e5cd0495796f0) Thanks [@cephalization](https://github.com/cephalization)! - Slash commands get a completion menu: type `/` to browse, tab to complete, enter to run. New commands: `/resume` switches to a previous session, `/new` starts a fresh one, and `/model` switches model from a picker of the models your key can use. With the menu closed, tab toggles asking before tools, and shift+tab cycles reasoning effort through the levels the model supports. The status line shows both. API errors now show the API's own message.

### Patch Changes

- [#6](https://github.com/cephalization/oi-agent/pull/6) [`6b5fd8d`](https://github.com/cephalization/oi-agent/commit/6b5fd8d2be076239af564fffe8d299f61bea4366) Thanks [@cephalization](https://github.com/cephalization)! - Code blocks in a streaming reply no longer flicker between code and plain text styling while a line is still arriving.

## 0.1.0

### Minor Changes

- package the CLI for npm and add release automation ([c5a1e30](https://github.com/cephalization/oi-agent/commit/c5a1e30d03d66aa028cb34e4d0fa8b9a2936ba71))
- ship source and a guide so oi can explain how it works ([e78a234](https://github.com/cephalization/oi-agent/commit/e78a234e89dc771c5537244de75fb2686a96530d))
