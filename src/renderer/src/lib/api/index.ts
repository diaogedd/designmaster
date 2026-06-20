import { registerAnthropicProvider } from './anthropic'
import { registerOpenAIChatProvider } from './openai-chat'
import { registerOpenAIResponsesProvider } from './openai-responses'
import { registerOpenAIImagesProvider } from './openai-images-provider'
import { registerGeminiProvider } from './gemini-provider'

/**
 * Register all API providers. Call once at app initialization.
 */
export function registerAllProviders(): void {
  registerAnthropicProvider()
  registerOpenAIChatProvider()
  registerOpenAIResponsesProvider()
  registerOpenAIImagesProvider()
  registerGeminiProvider()
}
