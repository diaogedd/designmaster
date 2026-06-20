/**
 * Generic SSE stream parser using fetch ReadableStream.
 * Yields parsed SSE events with optional event type and data.
 */
export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSEStream(response: Response): AsyncIterable<SSEEvent> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''

      for (const event of events) {
        const lines = event.split(/\r?\n/)
        const parsed: SSEEvent = { data: '' }
        for (const line of lines) {
          if (line.startsWith('event: ')) parsed.event = line.slice(7)
          else if (line.startsWith('data: ')) parsed.data = line.slice(6)
        }
        if (parsed.data) yield parsed
      }
    }
  } finally {
    reader.releaseLock()
  }
}
