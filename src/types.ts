export type ThemeMode = 'light' | 'dark' | 'system'

export type AppSettings = {
  baseUrl: string
  persistApiKey: boolean
  apiKey?: string
  themeMode?: ThemeMode
}

export type BackupSettings = Omit<AppSettings, 'apiKey' | 'persistApiKey'> & {
  persistApiKey: false
}

export type ModelOption = {
  id: string
  owned_by?: string
}

export type ImageGenerationPayload = {
  baseUrl: string
  apiKey: string
  mode?: 'text' | 'image'
  model: string
  prompt: string
  size: string
  quality: string
  count: number
  responseFormat: 'url' | 'b64_json'
  inputFidelity?: 'low' | 'high'
  referenceImages?: ReferenceImage[]
}

export type ReferenceImage = {
  id: string
  name: string
  type: string
  dataUrl: string
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
  prompt: string
  model: string
  size: string
  quality: string
  createdAt: number
  revisedPrompt?: string
  mode?: 'text' | 'image'
  referenceImageNames?: string[]
}

export type BackupFile = {
  version: 1
  exportedAt: number
  settings: BackupSettings
  images: LocalImageRecord[]
}

export type ImageApiClient = {
  listModels: (args: { baseUrl: string; apiKey: string }) => Promise<ModelOption[]>
  generateImages: (
    payload: ImageGenerationPayload
  ) => Promise<ImageGenerationResult>
  openExternal: (url: string) => Promise<void>
}
