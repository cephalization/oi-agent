/**
 * Secret scrubbing at write time.
 *
 * Sessions are synced to peers and exported to collectors, so secrets must
 * never reach a span file. Scrubbing happens before a tool result is recorded,
 * which also means the model only ever sees the scrubbed text.
 */

const PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export const REDACTED = "[redacted]"

export class Redactor {
  private readonly literals = new Set<string>()

  /** Register a known secret value so it is scrubbed wherever it appears. */
  add(secret: string | undefined): void {
    if (secret !== undefined && secret.length >= 8) this.literals.add(secret)
  }

  scrub(text: string): string {
    let out = text

    for (const literal of this.literals) out = out.replaceAll(literal, REDACTED)

    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED)

    return out
  }
}
