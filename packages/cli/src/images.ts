/**
 * Getting an image from a person's machine into a prompt: a file dropped on
 * the terminal, a path given to `/image` or `--image`, or the clipboard.
 *
 * A terminal has no drop event. Dropping a file pastes its path, quoted or
 * escaped the way that terminal does it, so a drop is recognized as a paste
 * that is nothing but paths of image files. Anything else pasted is text.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { imageTypeOf, MAX_IMAGE_BYTES, type NewImage } from "@oi-agent/engine"

/**
 * Split dropped paths on shell blanks and line breaks, not Unicode whitespace
 * (macOS screenshot names contain a narrow no-break space). Terminals quote
 * or escape paths in different ways, so accept all three forms.
 */
export const shellWords = (text: string): Array<string> => {
  const words: Array<string> = []
  let word = ""
  let quote = ""
  let started = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ""

    if (quote !== "") {
      if (char === quote) quote = ""
      else if (char === "\\" && quote === '"' && index + 1 < text.length) word += text[(index += 1)] ?? ""
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === "\\" && index + 1 < text.length) {
      word += text[(index += 1)] ?? ""
      started = true
    } else if (/[ \t\r\n]/.test(char)) {
      if (started || word !== "") words.push(word)

      word = ""
      started = false
    } else {
      word += char
    }
  }

  if (started || word !== "") words.push(word)

  return words
}

/** A pasted word as a path on this machine: a `file://` URL, `~`, or a path relative to `cwd`. */
const toPath = (word: string, cwd: string): string | undefined => {
  if (word.startsWith("file://")) {
    try {
      return fileURLToPath(word)
    } catch {
      return undefined
    }
  }

  if (word === "~" || word.startsWith("~/")) return path.join(os.homedir(), word.slice(1))

  return path.resolve(cwd, word)
}

/** Whether a file starts like an image oi can send, without reading all of it. */
const looksLikeImage = (file: string): boolean => {
  try {
    if (!fs.statSync(file).isFile()) return false

    const head = Buffer.alloc(12)
    const fd = fs.openSync(file, "r")

    try {
      fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }

    return imageTypeOf(head) !== undefined
  } catch {
    return false
  }
}

/**
 * The image files a paste names, when it names nothing else: what dropping
 * files on the terminal looks like. Undefined for any other paste, including
 * one that mixes prose with a path, which stays text.
 */
export const droppedImages = (pasted: string, cwd: string): Array<string> | undefined => {
  // A path is short. Prose that happens to be long is not worth splitting into words and stat-ing each.
  if (pasted.length > 8192) return undefined

  const files = shellWords(pasted).map((word) => toPath(word, cwd))

  return files.length > 0 && files.every((file) => file !== undefined && looksLikeImage(file))
    ? files.flatMap((file) => file ?? [])
    : undefined
}

/** Read an image file for attaching, or say why it cannot be read. */
export const readImage = (file: string, cwd: string): NewImage | string => {
  const resolved = toPath(file, cwd) ?? file

  try {
    const size = fs.statSync(resolved).size

    // Said before reading it: a mistaken path to something huge should not be loaded to find out.
    if (size > MAX_IMAGE_BYTES * 4)
      return `${path.basename(resolved)} is too large to be an attachable image.`

    return { name: path.basename(resolved), bytes: fs.readFileSync(resolved) }
  } catch {
    return `Could not read ${file}.`
  }
}

const run = (command: string, args: ReadonlyArray<string>): Buffer | undefined => {
  const result = spawnSync(command, args, {
    timeout: 3000,
    maxBuffer: MAX_IMAGE_BYTES * 4,
    stdio: ["ignore", "pipe", "ignore"],
  })

  return result.status === 0 && result.stdout.length > 0 ? result.stdout : undefined
}

/** AppleScript writes the clipboard's PNG data as `«data PNGf89504E47…»`. */
const fromAppleScript = (): Buffer | undefined => {
  const hex = /«data PNGf([0-9A-F]+)»/i.exec(
    run("osascript", ["-e", "the clipboard as «class PNGf»"])?.toString("utf8") ?? "",
  )?.[1]

  return hex === undefined ? undefined : Buffer.from(hex, "hex")
}

/**
 * The image on the clipboard, if there is one: a screenshot taken to the
 * clipboard has no file to drop. Uses what each system ships (`osascript`),
 * or the usual tools where none ships (`wl-paste`, `xclip`).
 */
export const clipboardImage = (platform: NodeJS.Platform = process.platform): NewImage | undefined => {
  const bytes =
    platform === "darwin"
      ? fromAppleScript()
      : (run("wl-paste", ["--no-newline", "--type", "image/png"]) ??
        run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]))

  return bytes === undefined || imageTypeOf(bytes) === undefined
    ? undefined
    : { name: "clipboard.png", bytes }
}
