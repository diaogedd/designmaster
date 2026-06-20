type UnknownRecord = Record<string, unknown>

export type OpenAIChatToolCallArgumentsSource = 'delta' | 'message'

export interface OpenAIChatToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
  extra_content?: Record<string, unknown>
}

export interface OpenAIChatToolCallFragment {
  index: number
  id?: string
  name?: string
  argumentsText?: string
  argumentsSource?: OpenAIChatToolCallArgumentsSource
  extraContent?: Record<string, unknown>
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asIndex(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeToolCall(value: unknown, fallbackIndex: number): OpenAIChatToolCallChunk | null {
  const record = asRecord(value)
  if (!record) return null

  const fnRecord = asRecord(record.function)
  const normalized: OpenAIChatToolCallChunk = {
    index: asIndex(record.index, fallbackIndex)
  }
  const id = asString(record.id)
  const type = asString(record.type)
  const name = asString(fnRecord?.name)
  const argumentsText = asString(fnRecord?.arguments)
  const extraContent = asRecord(record.extra_content)

  if (id) normalized.id = id
  if (type) normalized.type = type
  if (name !== undefined || argumentsText !== undefined) {
    normalized.function = {}
    if (name !== undefined) normalized.function.name = name
    if (argumentsText !== undefined) normalized.function.arguments = argumentsText
  }
  if (extraContent) normalized.extra_content = extraContent

  return normalized
}

function getToolCalls(container: unknown): OpenAIChatToolCallChunk[] {
  const record = asRecord(container)
  const toolCalls = record?.tool_calls
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .map((toolCall, index) => normalizeToolCall(toolCall, index))
    .filter((toolCall): toolCall is OpenAIChatToolCallChunk => Boolean(toolCall))
}

function getCallIndex(toolCall: OpenAIChatToolCallChunk, fallbackIndex: number): number {
  return typeof toolCall.index === 'number' && Number.isFinite(toolCall.index)
    ? toolCall.index
    : fallbackIndex
}

function toFragment(
  toolCall: OpenAIChatToolCallChunk,
  fallbackIndex: number,
  argumentsSource: OpenAIChatToolCallArgumentsSource
): OpenAIChatToolCallFragment {
  const argumentsText = toolCall.function?.arguments
  return {
    index: getCallIndex(toolCall, fallbackIndex),
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.function?.name ? { name: toolCall.function.name } : {}),
    ...(argumentsText !== undefined ? { argumentsText, argumentsSource } : {}),
    ...(toolCall.extra_content ? { extraContent: toolCall.extra_content } : {})
  }
}

/**
 * Some OpenAI-compatible gateways put a complete assistant `message.tool_calls`
 * snapshot inside a streamed chunk. Standard streaming clients only read
 * `delta.tool_calls`, so this merges the two shapes while preserving whether
 * arguments are true deltas or message-level snapshots.
 */
export function extractOpenAIChatToolCallFragments(choice: unknown): OpenAIChatToolCallFragment[] {
  const choiceRecord = asRecord(choice)
  if (!choiceRecord) return []

  const deltaCalls = getToolCalls(choiceRecord.delta)
  const messageCalls = getToolCalls(choiceRecord.message)
  if (deltaCalls.length === 0) {
    return messageCalls.map((toolCall, index) => toFragment(toolCall, index, 'message'))
  }

  const messageCallsByIndex = new Map<number, OpenAIChatToolCallChunk>()
  for (const [position, toolCall] of messageCalls.entries()) {
    messageCallsByIndex.set(getCallIndex(toolCall, position), toolCall)
  }

  const consumedMessageIndexes = new Set<number>()
  const fragments = deltaCalls.map((deltaCall, position) => {
    const index = getCallIndex(deltaCall, position)
    const messageCall = messageCallsByIndex.get(index)
    if (messageCall) consumedMessageIndexes.add(index)

    const deltaArguments = deltaCall.function?.arguments
    const messageArguments = messageCall?.function?.arguments
    const argumentsText = deltaArguments !== undefined ? deltaArguments : messageArguments
    const argumentsSource: OpenAIChatToolCallArgumentsSource | undefined =
      deltaArguments !== undefined
        ? 'delta'
        : messageArguments !== undefined
          ? 'message'
          : undefined

    return {
      index,
      ...((deltaCall.id ?? messageCall?.id) ? { id: deltaCall.id ?? messageCall?.id } : {}),
      ...((deltaCall.function?.name ?? messageCall?.function?.name)
        ? { name: deltaCall.function?.name ?? messageCall?.function?.name }
        : {}),
      ...(argumentsText !== undefined && argumentsSource ? { argumentsText, argumentsSource } : {}),
      ...((deltaCall.extra_content ?? messageCall?.extra_content)
        ? { extraContent: deltaCall.extra_content ?? messageCall?.extra_content }
        : {})
    }
  })

  for (const [position, messageCall] of messageCalls.entries()) {
    const index = getCallIndex(messageCall, position)
    if (!consumedMessageIndexes.has(index)) {
      fragments.push(toFragment(messageCall, position, 'message'))
    }
  }

  return fragments
}
