/**
 * Slash commands and their completion.
 *
 * The registry is the single list that `/help`, the completion menu and
 * dispatch all read, so a command cannot be documented but unreachable or
 * reachable but undiscoverable. Completion is a pure function of the input
 * line, which keeps it testable without a terminal.
 */

export interface CommandArgument {
  readonly name: string
  /** A required argument keeps the editor open after the command is picked. */
  readonly required: boolean
}

export interface Command {
  readonly name: string
  readonly summary: string
  readonly argument?: CommandArgument
  readonly aliases?: ReadonlyArray<string>
  /** Only the process running the session can do this; hidden when joined. */
  readonly hostOnly: boolean
}

export const COMMANDS: ReadonlyArray<Command> = [
  { name: "/help", summary: "list commands and keys", hostOnly: false },
  {
    name: "/resume",
    summary: "switch to a prior session, on disk or in Phoenix",
    argument: { name: "session", required: true },
    hostOnly: true,
  },
  { name: "/new", summary: "start a fresh session in this directory", hostOnly: true },
  {
    name: "/model",
    summary: "switch model from the next turn on",
    argument: { name: "model", required: true },
    hostOnly: true,
  },
  { name: "/tour", summary: "have the agent explain how it works, using this session", hostOnly: false },
  {
    name: "/share",
    summary: "share this session over tailcat (drive + view links)",
    argument: { name: "local", required: false },
    hostOnly: true,
  },
  { name: "/unshare", summary: "stop sharing", hostOnly: true },
  { name: "/evals", summary: "list the evaluators that review each turn", hostOnly: false },
  { name: "/rules", summary: "show rules learned from evaluator failures", hostOnly: false },
  { name: "/revert", summary: "undo the most recent learned rule", hostOnly: true },
  { name: "/export", summary: "send this session to Phoenix now", hostOnly: true },
  { name: "/yolo", summary: "stop asking before running tools (same as tab)", hostOnly: true },
  { name: "/quit", summary: "exit (the session stays on disk)", aliases: ["/exit"], hostOnly: false },
]

export const findCommand = (name: string, commands: ReadonlyArray<Command> = COMMANDS): Command | undefined =>
  commands.find((command) => command.name === name || (command.aliases ?? []).includes(name))

const usage = (command: Command): string => {
  const { argument } = command

  if (argument === undefined) return command.name

  return `${command.name} ${argument.required ? `<${argument.name}>` : `[${argument.name}]`}`
}

export const helpLines = (commands: ReadonlyArray<Command>): Array<string> => {
  const column = Math.max(...commands.map((command) => usage(command).length)) + 3

  return [
    ...commands.map((command) => `${usage(command).padEnd(column)}${command.summary}`),
    "",
    "In the / menu: tab complete · ↑↓ pick · enter run · esc close",
    "In /resume:   tab keeps the session on disk, or only in Phoenix",
    "Otherwise:  tab toggle yolo · shift+tab cycle reasoning effort",
    "            enter send · alt+enter newline · esc interrupt · ctrl+c clear or exit",
  ]
}

// --- completion ------------------------------------------------------------

export interface Suggestion {
  /** The text that replaces the token being completed. */
  readonly value: string
  readonly label: string
  readonly hint: string
  /** Extra text the filter matches against, beyond value and label. */
  readonly keywords?: string
}

export interface Completion {
  readonly kind: "command" | "argument"
  readonly command: Command | undefined
  /** Where the token being completed starts in the input. */
  readonly from: number
  readonly token: string
  readonly items: ReadonlyArray<Suggestion>
}

/** Prefix matches first, then anything containing the query. */
const rank = (items: ReadonlyArray<Suggestion>, query: string): Array<Suggestion> => {
  const needle = query.toLowerCase()
  const prefix: Array<Suggestion> = []
  const contains: Array<Suggestion> = []

  for (const item of items) {
    const value = item.value.toLowerCase()
    const haystack = `${value} ${item.label} ${item.keywords ?? ""}`.toLowerCase()

    if (value.startsWith(needle)) prefix.push(item)
    else if (haystack.includes(needle)) contains.push(item)
  }

  return [...prefix, ...contains]
}

/**
 * What can complete the input, if anything. Completion applies only to a
 * single-line slash command with the cursor at the end.
 */
export const complete = (
  input: string,
  cursor: number,
  commands: ReadonlyArray<Command>,
  argumentsFor: (command: Command) => ReadonlyArray<Suggestion>,
): Completion | undefined => {
  if (!input.startsWith("/") || input.includes("\n") || cursor !== input.length) return undefined

  const name = /^\/\S*$/.exec(input)?.[0]

  if (name !== undefined) {
    const items = rank(
      commands.map((command) => ({
        value: command.name,
        label: usage(command),
        hint: command.summary,
        keywords: (command.aliases ?? []).join(" "),
      })),
      name,
    )

    return items.length === 0
      ? undefined
      : { kind: "command", command: undefined, from: 0, token: name, items }
  }

  const match = /^(\/\S+)\s+(.*)$/.exec(input)
  const command = match === null ? undefined : findCommand(match[1] ?? "", commands)

  if (match === null || command?.argument === undefined) return undefined

  const token = match[2] ?? ""
  const items = rank(argumentsFor(command), token)

  return items.length === 0
    ? undefined
    : { kind: "argument", command, from: input.length - token.length, token, items }
}

/** The input after accepting a suggestion. A command that takes an argument gets a space. */
export const accept = (input: string, completion: Completion, item: Suggestion): string => {
  if (completion.kind === "argument") return `${input.slice(0, completion.from)}${item.value}`

  return findCommand(item.value)?.argument === undefined ? item.value : `${item.value} `
}

export type EnterAction =
  /** Let the editor submit the line as typed. */
  | { readonly type: "submit" }
  /** Replace the line and send it. */
  | { readonly type: "send"; readonly text: string }
  /** Replace the line and keep editing (an argument is still needed). */
  | { readonly type: "fill"; readonly text: string }

/**
 * What enter does while the menu is open. It picks the highlighted
 * suggestion unless the line already says exactly what to run.
 */
export const onEnter = (input: string, completion: Completion, item: Suggestion): EnterAction => {
  const command = completion.kind === "command" ? findCommand(item.value) : completion.command
  const required = command?.argument?.required === true
  const text = accept(input, completion, item)

  if (completion.kind === "command") {
    if (required) return { type: "fill", text }

    return completion.token === item.value ? { type: "submit" } : { type: "send", text: text.trimEnd() }
  }

  // An optional argument left blank means "run it without one".
  if (completion.token === "" && !required) return { type: "submit" }

  return { type: "send", text }
}
