/**
 * Images attached to a prompt.
 *
 * The bytes are a file of their own in the session tree,
 * `attachments/<sha256>.json`, named by their content, so the file is
 * immutable like an ended span and syncs the same way. A prompt carries only
 * references to them: on its inbox entry while it waits, and on the turn's
 * root span (`metadata.oi_agent.attachments`) or its `steered` record once a
 * turn has read it. The fold turns a reference back into an image block of
 * the first request that sends it; from then on the image is part of that
 * request's stored body and is replayed verbatim like the rest.
 *
 * Nothing here asks whether a model can read images. The request is sent and
 * a provider that cannot read it says so.
 */
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { formatBytes } from "./bytes.ts"
import type { AttachmentFile, AttachmentRef, ImageType } from "./format.ts"

/** An image as a provider's request carries it. */
export interface Image {
  readonly media_type: ImageType
  /** Base64, without a `data:` prefix. */
  readonly data: string
}

/** An image someone is attaching, before it is part of a session. */
export interface NewImage {
  readonly name: string
  readonly bytes: Buffer
}

/** Anthropic's limit per image, the lowest among the providers oi drives. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const MAX_IMAGES_PER_PROMPT = 10

/** What a whole prompt's images may weigh: bounds a joiner's upload and the request that follows. */
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024

const startsWith = (bytes: Buffer, signature: ReadonlyArray<number>, offset = 0): boolean =>
  signature.every((byte, index) => bytes[offset + index] === byte)

/**
 * The image format, read from the bytes themselves: a file's name is not
 * evidence, and a peer's claim about its upload even less.
 */
export const imageTypeOf = (bytes: Buffer): ImageType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"

  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"

  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp"

  return undefined
}

/** Why these images cannot be attached to one prompt, or undefined when they can. */
export const imagesProblem = (
  images: ReadonlyArray<{ readonly name: string; readonly bytes: number }>,
): string | undefined => {
  if (images.length > MAX_IMAGES_PER_PROMPT)
    return `A prompt takes at most ${MAX_IMAGES_PER_PROMPT} images, and this would be ${images.length}.`

  const large = images.find((image) => image.bytes > MAX_IMAGE_BYTES)

  if (large !== undefined)
    return `${large.name} is ${formatBytes(large.bytes)}; an image can be at most ${formatBytes(MAX_IMAGE_BYTES)}.`

  const total = images.reduce((sum, image) => sum + image.bytes, 0)

  return total > MAX_PROMPT_IMAGE_BYTES
    ? `These images are ${formatBytes(total)} together; a prompt takes at most ${formatBytes(MAX_PROMPT_IMAGE_BYTES)}.`
    : undefined
}

/** A name safe to show and to store: no directories, no control characters, not endless. */
const displayName = (name: string): string =>
  // oxlint-disable-next-line no-control-regex
  (name.split(/[\\/]/).at(-1) ?? "").replaceAll(/[\u0000-\u001F\u007F]/g, "").slice(0, 120) || "image"

/** The file an image becomes, or why it cannot be one. */
export const attachmentFrom = (image: NewImage): AttachmentFile | string => {
  const name = displayName(image.name)
  const media_type = imageTypeOf(image.bytes)

  if (media_type === undefined) return `${name} is not a PNG, JPEG, GIF or WebP image.`

  return {
    id: createHash("sha256").update(image.bytes).digest("hex"),
    name,
    media_type,
    bytes: image.bytes.length,
    data: image.bytes.toString("base64"),
  }
}

/**
 * Attaching returns what was attached, or a sentence saying why not: this
 * tells them apart, here and for a caller.
 */
export const isProblem = Schema.is(Schema.String)

/** The files a prompt's images become, or the first reason they cannot all be attached. */
export const attachmentsFrom = (images: ReadonlyArray<NewImage>): Array<AttachmentFile> | string => {
  const problem = imagesProblem(images.map((image) => ({ name: image.name, bytes: image.bytes.length })))

  if (problem !== undefined) return problem

  const files: Array<AttachmentFile> = []

  for (const image of images) {
    const file = attachmentFrom(image)

    if (isProblem(file)) return file

    files.push(file)
  }

  return files
}

/** Whether a file's contents are what its name says: the check a peer's copy gets on arrival. */
export const intact = (file: AttachmentFile): boolean => {
  const bytes = Buffer.from(file.data, "base64")

  return (
    bytes.length === file.bytes &&
    imageTypeOf(bytes) === file.media_type &&
    createHash("sha256").update(bytes).digest("hex") === file.id
  )
}

export const refOf = (file: AttachmentFile): AttachmentRef => ({
  id: file.id,
  name: file.name,
  media_type: file.media_type,
  bytes: file.bytes,
})

/** `shot.png (240 KB)`, for a transcript or a status line. */
export const describeAttachment = (ref: Pick<AttachmentRef, "name" | "bytes">): string =>
  `${ref.name} (${formatBytes(ref.bytes)})`

/** What stands in for an image whose bytes this machine does not have. */
export const missingImageNote = (ref: AttachmentRef): string =>
  `[The image ${ref.name} was attached here, but its contents are not available on this machine.]`
