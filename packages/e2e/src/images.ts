/**
 * Test images, made here so no binary fixture is checked in: a square of one
 * colour, which a model can only name by reading the pixels.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as zlib from "node:zlib"

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const framed = Buffer.alloc(body.length + 8)

  framed.writeUInt32BE(data.length, 0)
  body.copy(framed, 4)
  framed.writeUInt32BE(zlib.crc32(body), body.length + 4)

  return framed
}

/** A PNG of one RGB colour. */
export const solidPng = (red: number, green: number, blue: number, size: number = 64): Buffer => {
  const header = Buffer.alloc(13)

  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  // 8 bits per channel, truecolour, no interlace.
  header.set([8, 2, 0, 0, 0], 8)

  // Each row: a filter byte (none), then the pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([red, green, blue]))])

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export const RED = solidPng(220, 20, 20)
export const BLUE = solidPng(20, 40, 220)

/** Write an image somewhere and return its path. */
export const writeImage = (dir: string, name: string, bytes: Buffer): string => {
  const file = path.join(dir, name)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, bytes)

  return file
}
