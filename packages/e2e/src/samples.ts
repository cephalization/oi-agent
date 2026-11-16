/** Bounded workers drain before rejecting, so scenario cleanup never races a sample. */
export const mapSamples = async <A, B>(
  entries: ReadonlyArray<A>,
  limit: number,
  body: (entry: A, index: number) => Promise<B>,
): Promise<Array<B>> => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer")

  const results: Array<B> = []
  let next = 0
  let failed = false
  let failure: Error | undefined

  const worker = async (): Promise<void> => {
    while (!failed && next < entries.length) {
      const index = next++

      try {
        results[index] = await body(entries[index]!, index)
      } catch (error) {
        failed = true
        failure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker))

  if (failure !== undefined) throw failure

  return results
}

export const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)

  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)

  return value
}
