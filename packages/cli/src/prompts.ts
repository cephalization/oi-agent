/** Small line-oriented terminal prompts for setup. */
import { style } from "./tui/ansi.ts"

const out = (text: string): void => {
  process.stdout.write(text)
}

// One key: a CSI sequence, or a single character.
// oxlint-disable-next-line no-control-regex
const KEYS = /\u001B\[[0-9;]*[A-Za-z~]|[\s\S]/gu

const CANCELLED = new Error("Setup cancelled.")

/**
 * Read one line in raw mode. With `mask` set, typed characters are shown as
 * dots so a secret never appears on screen or in scrollback.
 */
const readLine = (mask: boolean): Promise<string> =>
  new Promise((resolve, reject) => {
    let value = ""

    const finish = (result: () => void): void => {
      process.stdin.off("data", onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      out("\n")
      result()
    }

    const onKey = (key: string): boolean => {
      if (key === "\r" || key === "\n") {
        finish(() => resolve(value))

        return true
      }

      if (key === "\u0003" || key === "\u0004") {
        finish(() => reject(CANCELLED))

        return true
      }

      if (key === "\u007F" || key === "\b") {
        if (value.length > 0) out("\b \b")

        value = value.slice(0, -1)
      } else if (!key.startsWith("\u001B") && key >= " ") {
        value += key
        out(mask ? "•" : key)
      }

      return false
    }

    const onData = (data: Buffer): void => {
      // Strip bracketed-paste markers so a pasted key is taken as typed.
      // oxlint-disable-next-line no-control-regex
      const text = data.toString("utf8").replaceAll(/\u001B\[20[01]~/g, "")

      for (const key of text.match(KEYS) ?? []) {
        if (onKey(key)) return
      }
    }

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
  })

/** Ask for a line of text. Return on an empty line accepts the default. */
export const ask = async (question: string, fallback: string = ""): Promise<string> => {
  out(`${style.bold(question)}${fallback === "" ? "" : style.gray(` (${fallback})`)}: `)

  const answer = (await readLine(false)).trim()

  return answer === "" ? fallback : answer
}

/** Ask for a secret. The input is masked. An empty line means "none". */
export const askSecret = async (question: string): Promise<string> => {
  out(`${style.bold(question)}: `)

  return (await readLine(true)).trim()
}

export interface Choice<A> {
  readonly value: A
  readonly label: string
  readonly hint?: string
}

/** Pick one of a numbered list. Return accepts the default. */
export const choose = async <A>(
  question: string,
  choices: ReadonlyArray<Choice<A>>,
  fallback: A,
): Promise<A> => {
  const initial = Math.max(
    choices.findIndex((choice) => choice.value === fallback),
    0,
  )

  out(`${style.bold(question)}\n`)

  for (const [index, choice] of choices.entries()) {
    const hint = choice.hint === undefined ? "" : style.gray(`  ${choice.hint}`)

    out(`  ${style.cyan(String(index + 1))}  ${choice.label}${hint}\n`)
  }

  for (;;) {
    out(`${style.gray(`choice (${initial + 1})`)}: `)

    const answer = (await readLine(false)).trim()
    const picked = answer === "" ? choices[initial] : choices[Number(answer) - 1]

    if (picked !== undefined) return picked.value

    out(style.yellow(`Enter a number from 1 to ${choices.length}.\n`))
  }
}

export const confirm = async (question: string, fallback: boolean): Promise<boolean> => {
  const answer = (await ask(`${question} ${style.gray(fallback ? "[Y/n]" : "[y/N]")}`)).toLowerCase()

  return answer === "" ? fallback : answer.startsWith("y")
}

export const say = (text: string = ""): void => out(`${text}\n`)

export const isCancelled = (error: Error): boolean => error === CANCELLED
