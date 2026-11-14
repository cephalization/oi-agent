/** Approval-dialog keys. Granting one call in auto mode must not enable yolo. */
import type { ApprovalMode } from "@oi-agent/engine"

export type ApprovalAction = "allow" | "deny" | "yolo"

export const approvalAction = (mode: ApprovalMode, key: string): ApprovalAction | undefined => {
  const pressed = key.toLowerCase()

  if (pressed === "y") return "allow"

  if (pressed === "n") return "deny"

  if (pressed === "a" && mode === "ask") return "yolo"

  return undefined
}
