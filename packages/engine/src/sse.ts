/** The `data:` payloads of a server-sent event stream. */
export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })

    let boundary = /\r?\n\r?\n/.exec(buffer)

    while (boundary !== null) {
      const event = buffer.slice(0, boundary.index)

      buffer = buffer.slice(boundary.index + boundary[0].length)

      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")

      if (data !== "" && data !== "[DONE]") yield data

      boundary = /\r?\n\r?\n/.exec(buffer)
    }
  }
}
