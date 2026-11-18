import { execFile } from "node:child_process"
import type { FeedbackIssue } from "@oi-agent/engine"

const REPOSITORY = "github.com/cephalization/oi-agent"
export const FEEDBACK_DESTINATION = `https://${REPOSITORY}/issues`
export const FEEDBACK_MANUAL = `To file manually, open ${FEEDBACK_DESTINATION} and choose New issue.`

export type FeedbackPosting =
  | { readonly status: "posted"; readonly url: string }
  | { readonly status: "missing" | "unconfirmed" }

/** Called only by the local confirmation flow. Never starts a shell or an interactive gh prompt. */
export const postFeedback = (issue: FeedbackIssue): Promise<FeedbackPosting> =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["issue", "create", `--repo=${REPOSITORY}`, `--title=${issue.title}`, `--body=${issue.body}`],
      {
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        shell: false,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const url = stdout.trim()
        const number = url.slice(FEEDBACK_DESTINATION.length + 1)

        if (error === null && url.startsWith(`${FEEDBACK_DESTINATION}/`) && /^[1-9]\d*$/.test(number))
          return resolve({ status: "posted", url })

        // Do not echo gh diagnostics, which can contain paths, account details, or debug output.
        resolve({ status: error?.code === "ENOENT" ? "missing" : "unconfirmed" })
      },
    )
  })
