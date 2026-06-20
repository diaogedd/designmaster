import { nanoid } from 'nanoid'
import { joinFsPath } from '@renderer/lib/agent/memory-files'
import { createProvider } from '@renderer/lib/api/provider'
import type {
  ImageBlock,
  ProviderConfig,
  TextBlock,
  ToolResultContent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolContext, ToolHandler } from '@renderer/lib/tools/tool-types'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import {
  isRetryableImageError,
  waitForImageGenerateRetry,
  type ImageGenerateRetryState
} from './image-tool-retry'
import { IMAGE_GENERATE_TOOL_NAME } from './types'

function normalizeCount(input: unknown): number {
  const parsed = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(4, Math.floor(parsed)))
}

function normalizeStringInput(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  return value || undefined
}

function normalizeReferenceImages(input: unknown): string[] {
  const source = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  return source
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6)
}

function normalizeImageSize(input: unknown): string | undefined {
  const value = normalizeStringInput(input)
  if (!value || value === 'auto') return undefined
  if (['1024x1024', '1024x1536', '1536x1024'].includes(value)) return value
  return undefined
}

function normalizeImageQuality(input: unknown): string | undefined {
  const value = normalizeStringInput(input)
  if (!value || value === 'auto') return undefined
  if (['low', 'medium', 'high'].includes(value)) return value
  return undefined
}

function isAbsoluteReferencePath(filePath: string): boolean {
  return filePath.startsWith('/') || filePath.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(filePath)
}

function resolveReferencePath(filePath: string, ctx: ToolContext): string {
  if (isAbsoluteReferencePath(filePath)) return filePath
  if (ctx.workingFolder) return joinFsPath(ctx.workingFolder, filePath)
  return filePath
}

function mediaTypeFromPath(filePath: string): string {
  const normalized = filePath.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.webp')) return 'image/webp'
  if (normalized.endsWith('.gif')) return 'image/gif'
  if (normalized.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

async function readReferenceImageBlocks(
  referenceImages: string[],
  ctx: ToolContext
): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = []

  for (const referenceImage of referenceImages) {
    const filePath = resolveReferencePath(referenceImage, ctx)
    const result = (await ctx.ipc.invoke(IPC.FS_READ_FILE_BINARY, { path: filePath })) as {
      data?: unknown
      error?: unknown
    }
    if (typeof result?.error === 'string' && result.error) {
      throw new Error(`Failed to read reference image "${filePath}": ${result.error}`)
    }
    if (typeof result?.data !== 'string' || result.data.length === 0) {
      throw new Error(`Failed to read reference image "${filePath}": no image data returned`)
    }

    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        mediaType: mediaTypeFromPath(filePath),
        data: result.data,
        filePath
      }
    })
  }

  return blocks
}

function withImageRequestOverrides(
  config: ProviderConfig,
  overrides: { size?: string; quality?: string }
): ProviderConfig {
  if (!overrides.size && !overrides.quality) return config

  return {
    ...config,
    requestOverrides: {
      ...(config.requestOverrides ?? {}),
      body: {
        ...(config.requestOverrides?.body ?? {}),
        ...(overrides.size ? { size: overrides.size } : {}),
        ...(overrides.quality ? { quality: overrides.quality } : {})
      }
    }
  }
}

function isErrorResult(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
}

function formatDateSegment(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function extensionFromMediaType(mediaType?: string): string {
  const normalized = mediaType?.split(';', 1)[0]?.trim().toLowerCase()

  switch (normalized) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'image/png':
    default:
      return 'png'
  }
}

async function resolveImageOutputDir(ctx: ToolContext): Promise<string> {
  const homeDir = await ctx.ipc.invoke(IPC.APP_HOMEDIR)
  if (typeof homeDir !== 'string' || homeDir.trim().length === 0) {
    throw new Error('Failed to resolve current user home directory.')
  }

  return joinFsPath(homeDir, '.open-cowork', 'images', formatDateSegment())
}

async function resolveGeneratedImageBinary(
  image: ImageBlock,
  ctx: ToolContext
): Promise<{ data: string; mediaType: string }> {
  if (image.source.type === 'base64' && image.source.data) {
    return {
      data: image.source.data,
      mediaType: image.source.mediaType || 'image/png'
    }
  }

  if (image.source.type === 'url' && image.source.url) {
    const result = await ctx.ipc.invoke('image:fetch-base64', { url: image.source.url })
    if (isErrorResult(result)) {
      throw new Error(`Failed to download generated image: ${result.error}`)
    }

    const data = (result as { data?: unknown }).data
    const mimeType = (result as { mimeType?: unknown }).mimeType
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('Generated image download returned no data.')
    }

    return {
      data,
      mediaType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/png'
    }
  }

  throw new Error('Generated image data is missing.')
}

async function persistGeneratedImage(
  image: ImageBlock,
  ctx: ToolContext,
  outputDir: string,
  index: number
): Promise<string> {
  const { data, mediaType } = await resolveGeneratedImageBinary(image, ctx)
  const fileName = `image-${Date.now()}-${index + 1}-${nanoid(8)}.${extensionFromMediaType(mediaType)}`
  const filePath = joinFsPath(outputDir, fileName)
  const writeResult = await ctx.ipc.invoke(IPC.FS_WRITE_FILE_BINARY, {
    path: filePath,
    data
  })

  if (isErrorResult(writeResult)) {
    throw new Error(`Failed to save generated image: ${writeResult.error}`)
  }

  return filePath
}

function buildImageToolOutput(
  savedPaths: string[],
  images: ImageBlock[],
  notes: string[] = []
): ToolResultContent {
  const content: Array<TextBlock | ImageBlock> = []

  if (savedPaths.length > 0) {
    content.push({
      type: 'text',
      text: `Saved image absolute paths:\n${savedPaths.join('\n')}`
    })
  }

  content.push(...images)

  for (const note of notes) {
    content.push({
      type: 'text',
      text: note
    })
  }

  return content
}

function updateLiveImageToolState(
  ctx: ToolContext,
  baseInput: Record<string, unknown>,
  savedPaths: string[],
  images: ImageBlock[],
  notes: string[] = [],
  retryState?: ImageGenerateRetryState
): void {
  if (!ctx.currentToolUseId) return

  useAgentStore.getState().updateToolCall(ctx.currentToolUseId, {
    input: retryState
      ? {
          ...baseInput,
          _retryState: retryState
        }
      : baseInput,
    output: buildImageToolOutput(savedPaths, images, notes)
  })
}

export const imageGenerateTool: ToolHandler = {
  definition: {
    name: IMAGE_GENERATE_TOOL_NAME,
    description:
      'Generate images when the user needs visual content. Use proactively whenever an image would help—whether they explicitly ask for one or imply a need (e.g. "show me", "what does X look like", creating illustrations/icons/diagrams, visualizing concepts). When writing the prompt: align with user intent, include subject/style/composition/mood, be specific and concrete, infer style from user wording. count defaults to 1, max 4.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Complete visual prompt aligned with user intent. Include: subject, style (e.g. realistic, cartoon, minimalist), composition, lighting/mood. Be specific and concrete; infer style from user wording (e.g. "cute" → cute/kawaii style). Prefer concise, descriptive English; avoid vague or abstract phrasing.'
        },
        count: {
          type: 'number',
          description: 'How many images to generate. Defaults to 1 and is capped at 4.'
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional local image paths to use as visual references. Each path may be absolute or relative to the working folder. Up to 6 images are used.'
        },
        size: {
          type: 'string',
          enum: ['auto', '1024x1024', '1024x1536', '1536x1024'],
          description:
            'Optional image size. Use auto or omit to keep the configured provider default.'
        },
        quality: {
          type: 'string',
          enum: ['auto', 'low', 'medium', 'high'],
          description:
            'Optional image quality. Use auto or omit to keep the configured provider default.'
        }
      },
      required: ['prompt']
    }
  },
  execute: async (input, ctx): Promise<ToolResultContent> => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const count = normalizeCount(input.count)
    const referenceImages = normalizeReferenceImages(input.reference_images)
    const size = normalizeImageSize(input.size)
    const quality = normalizeImageQuality(input.quality)

    if (!prompt) {
      return JSON.stringify({ error: 'ImageGenerate requires a non-empty prompt.' })
    }

    const resolvedProviderConfig = useAppPluginStore.getState().getResolvedImagePluginConfig()
    if (!resolvedProviderConfig) {
      return JSON.stringify({
        error: 'Image plugin is disabled or has no valid image model configured.'
      })
    }

    let referenceImageBlocks: ImageBlock[] = []
    try {
      referenceImageBlocks = await readReferenceImageBlocks(referenceImages, ctx)
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }

    const providerConfig = withImageRequestOverrides(resolvedProviderConfig, { size, quality })
    const provider = createProvider(providerConfig)
    const outputDir = await resolveImageOutputDir(ctx)
    const images: ImageBlock[] = []
    const notes: string[] = []
    const savedPaths: string[] = []
    const baseInput = {
      prompt,
      count,
      ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {})
    }
    if (referenceImageBlocks.length > 0) {
      notes.push(`Using ${referenceImageBlocks.length} reference image(s).`)
    }

    updateLiveImageToolState(ctx, baseInput, savedPaths, images)

    for (let index = 0; index < count; index += 1) {
      let retryAttempt = 0

      while (true) {
        const userMessage: UnifiedMessage = {
          id: nanoid(),
          role: 'user',
          content:
            referenceImageBlocks.length > 0
              ? [{ type: 'text', text: prompt }, ...referenceImageBlocks]
              : prompt,
          createdAt: Date.now()
        }

        let iterationFailed = false
        let iterationError = 'Unknown image generation error.'
        let iterationErrorCode:
          | 'timeout'
          | 'network'
          | 'request_aborted'
          | 'api_error'
          | 'unknown'
          | undefined
        const iterationImages: ImageBlock[] = []

        for await (const event of provider.sendMessage(
          [userMessage],
          [],
          providerConfig,
          ctx.signal
        )) {
          if (event.type === 'image_generated' && event.imageBlock) {
            iterationImages.push(event.imageBlock)
          }

          if (event.type === 'image_error' && event.imageError) {
            iterationFailed = true
            iterationError = event.imageError.message
            iterationErrorCode = event.imageError.code
          }
        }

        if (iterationFailed) {
          if (ctx.currentToolUseId && isRetryableImageError(iterationError, iterationErrorCode)) {
            const retryState: ImageGenerateRetryState = {
              status: 'awaiting_retry',
              attempt: retryAttempt + 1,
              completedCount: images.length,
              totalCount: count,
              errorMessage: iterationError
            }
            const retryNotes = [
              ...notes,
              `Image ${index + 1}/${count} hit rate limit. Generated ${images.length}/${count} image(s). Click retry to continue.`
            ]
            updateLiveImageToolState(ctx, baseInput, savedPaths, images, retryNotes, retryState)

            const shouldRetry = await waitForImageGenerateRetry(ctx.currentToolUseId, ctx.signal)
            if (!shouldRetry) {
              return JSON.stringify({
                error: 'Image generation was cancelled while waiting for retry.'
              })
            }

            retryAttempt += 1
            updateLiveImageToolState(ctx, baseInput, savedPaths, images, notes)
            continue
          }

          if (images.length === 0) {
            return JSON.stringify({ error: iterationError })
          }

          notes.push(
            `Stopped after ${images.length} image(s). Request ${index + 1} failed: ${iterationError}`
          )
          updateLiveImageToolState(ctx, baseInput, savedPaths, images, notes)
          break
        }

        try {
          const iterationSavedPaths: string[] = []
          for (const [imageIndex, image] of iterationImages.entries()) {
            const savedPath = await persistGeneratedImage(
              image,
              ctx,
              outputDir,
              savedPaths.length + imageIndex
            )
            iterationSavedPaths.push(savedPath)
          }

          images.push(...iterationImages)
          savedPaths.push(...iterationSavedPaths)
          updateLiveImageToolState(ctx, baseInput, savedPaths, images, notes)
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (images.length === 0) {
            return JSON.stringify({ error: message })
          }

          notes.push(`Stopped after ${images.length} image(s). Failed to persist image: ${message}`)
          updateLiveImageToolState(ctx, baseInput, savedPaths, images, notes)
          break
        }
      }
    }

    if (images.length === 0) {
      return JSON.stringify({ error: 'Image generation returned no images.' })
    }

    updateLiveImageToolState(ctx, baseInput, savedPaths, images, notes)
    return buildImageToolOutput(savedPaths, images, notes)
  },
  requiresApproval: () => false
}
