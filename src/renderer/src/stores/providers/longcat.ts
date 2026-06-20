import type { BuiltinProviderPreset } from './types'

export const longcatPreset: BuiltinProviderPreset = {
  builtinId: 'longcat',
  name: 'LongCat',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.longcat.chat/openai/v1',
  homepage: 'https://api.longcat.chat',
  defaultEnabled: false,
  defaultModels: [
    {
      id: 'LongCat-Flash-Chat',
      name: 'LongCat Flash Chat',
      icon: 'longcat',
      enabled: true,
      supportsFunctionCall: true
    },
    {
      id: 'LongCat-Flash-Thinking',
      name: 'LongCat Flash Thinking',
      icon: 'longcat',
      enabled: true,
      supportsFunctionCall: true
    },
    {
      id: 'LongCat-Flash-Thinking-2601',
      name: 'LongCat Flash Thinking 2601',
      icon: 'longcat',
      enabled: true,
      supportsFunctionCall: true
    },
    {
      id: 'LongCat-Flash-Lite',
      name: 'LongCat Flash Lite',
      icon: 'longcat',
      enabled: true,
      supportsFunctionCall: true
    },
    {
      id: 'LongCat-Flash-Omni-2603',
      name: 'LongCat Flash Omni 2603',
      icon: 'longcat',
      enabled: true,
      supportsVision: true,
      supportsFunctionCall: true
    },
    {
      id: 'LongCat-Flash-Chat-2602-Exp',
      name: 'LongCat Flash Chat 2602 Exp',
      icon: 'longcat',
      enabled: true,
      supportsFunctionCall: true
    }
  ]
}
