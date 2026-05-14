export type ThemeMode = 'light' | 'dark' | 'system'

export type AppSettings = {
  baseUrl: string
  persistApiKey: boolean
  apiKey?: string
  themeMode?: ThemeMode
  galleryDir?: string
}

export type ModelOption = {
  id: string
  owned_by?: string
}

export type ImageGenerationPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  size: string
  quality: string
  count: number
  responseFormat: 'url' | 'b64_json'
}

export type GeneratedImage = {
  src: string
  revisedPrompt?: string
}

export type ImageGenerationResult = {
  images: GeneratedImage[]
}

export type LocalImageRecord = {
  id: string
  src: string
  filePath?: string
  filename?: string
  prompt: string
  model: string
  size: string
  quality: string
  createdAt: number
  revisedPrompt?: string
}
