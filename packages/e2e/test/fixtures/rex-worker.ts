import { createInterface } from "node:readline"
import { RexTerminal } from "../../src/term.ts"

const started = await Promise.allSettled(
  Array.from({ length: 4 }, (_, i) =>
    RexTerminal.start(`oi-e2e-regression-${process.pid}-${i}`, process.cwd(), ["/bin/cat"]),
  ),
)

const terminals: Array<RexTerminal> = []

for (const result of started) {
  if (result.status === "fulfilled") terminals.push(result.value)
}

try {
  for (const result of started) {
    if (result.status === "rejected") throw result.reason
  }

  console.log(JSON.stringify(terminals.map(({ session, block }) => ({ session, block }))))

  const input = createInterface({ input: process.stdin })

  for await (const line of input) {
    if (line === "close") break
  }

  input.close()
} finally {
  await Promise.all(terminals.map((term) => term.close()))
  // A repeated close must not affect another worker.
  await Promise.all(terminals.map((term) => term.close()))
}
