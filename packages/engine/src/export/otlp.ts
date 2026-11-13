/**
 * The projection from span files to OTLP.
 *
 * Phoenix accepts OTLP traces only as protobuf, so this encodes the handful
 * of messages a trace export needs directly. Field numbers are from
 * opentelemetry-proto `trace/v1/trace.proto` and `common/v1/common.proto`.
 */
import { Schema } from "effect"
import { AttrPrimitive, type Attributes, type EndedSpan } from "../format.ts"
import { isoToNs } from "../ids.ts"

const VARINT = 0
const FIXED64 = 1
const BYTES = 2

class Writer {
  private readonly chunks: Array<Uint8Array> = []

  private varint(value: bigint): void {
    const bytes: Array<number> = []
    let rest = BigInt.asUintN(64, value)

    while (rest > 127n) {
      bytes.push(Number(rest & 127n) | 128)
      rest >>= 7n
    }

    bytes.push(Number(rest))
    this.chunks.push(Uint8Array.from(bytes))
  }

  private tag(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire))
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, BYTES)
    this.varint(BigInt(value.length))
    this.chunks.push(value)

    return this
  }

  string(field: number, value: string): this {
    return value === "" ? this : this.bytes(field, Buffer.from(value, "utf8"))
  }

  message(field: number, value: Writer): this {
    return this.bytes(field, value.finish())
  }

  int(field: number, value: bigint): this {
    this.tag(field, VARINT)
    this.varint(value)

    return this
  }

  fixed64(field: number, value: bigint): this {
    const buffer = Buffer.alloc(8)

    buffer.writeBigUInt64LE(BigInt.asUintN(64, value))
    this.tag(field, FIXED64)
    this.chunks.push(buffer)

    return this
  }

  double(field: number, value: number): this {
    const buffer = Buffer.alloc(8)

    buffer.writeDoubleLE(value)
    this.tag(field, FIXED64)
    this.chunks.push(buffer)

    return this
  }

  finish(): Uint8Array {
    return Buffer.concat(this.chunks)
  }
}

const isPrimitive = Schema.is(AttrPrimitive)
const isText = (value: AttrPrimitive): value is string => String(value) === value
const isFlag = (value: AttrPrimitive): value is boolean => value === true || value === false

const anyValue = (value: AttrPrimitive): Writer => {
  const writer = new Writer()

  // An empty string must still be written, or the value would be unset.
  if (isText(value)) return writer.bytes(1, Buffer.from(value, "utf8"))

  if (isFlag(value)) return writer.int(2, value ? 1n : 0n)

  return Number.isInteger(value) ? writer.int(3, BigInt(value)) : writer.double(4, value)
}

const keyValue = (key: string, value: Attributes[string]): Writer => {
  const writer = new Writer().string(1, key)

  if (isPrimitive(value)) return writer.message(2, anyValue(value))

  const list = new Writer()

  for (const item of value) list.message(1, anyValue(item))

  return writer.message(2, new Writer().message(5, list))
}

const attributes = (writer: Writer, field: number, attrs: Attributes): void => {
  for (const [key, value] of Object.entries(attrs)) writer.message(field, keyValue(key, value))
}

const STATUS = { UNSET: 0n, OK: 1n, ERROR: 2n }

const SPAN_KIND_INTERNAL = 1n

const encodeSpan = (span: EndedSpan): Writer => {
  const writer = new Writer()
    .bytes(1, Buffer.from(span.context.trace_id, "hex"))
    .bytes(2, Buffer.from(span.context.span_id, "hex"))

  if (span.parent_id !== null) writer.bytes(4, Buffer.from(span.parent_id, "hex"))

  writer
    .string(5, span.name)
    .int(6, SPAN_KIND_INTERNAL)
    .fixed64(7, isoToNs(span.start_time))
    .fixed64(8, isoToNs(span.end_time))
  attributes(writer, 9, span.attributes)

  for (const event of span.events) {
    const encoded = new Writer().fixed64(1, isoToNs(event.timestamp)).string(2, event.name)

    attributes(encoded, 3, event.attributes)
    writer.message(11, encoded)
  }

  return writer.message(15, new Writer().string(2, span.status_message).int(3, STATUS[span.status_code]))
}

export interface ResourceInfo {
  /** Phoenix routes spans to a project by this resource attribute. */
  readonly project: string
  readonly serviceName: string
}

/** Encode spans as an OTLP `ExportTraceServiceRequest`. */
export const encodeTraceRequest = (spans: ReadonlyArray<EndedSpan>, resource: ResourceInfo): Uint8Array => {
  const scope = new Writer().message(1, new Writer().string(1, "oi-agent"))

  for (const span of spans) scope.message(2, encodeSpan(span))

  const resourceMessage = new Writer()
    .message(1, keyValue("service.name", resource.serviceName))
    .message(1, keyValue("openinference.project.name", resource.project))

  return new Writer().message(1, new Writer().message(1, resourceMessage).message(2, scope)).finish()
}
