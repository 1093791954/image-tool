export type ThemeMode = 'light' | 'dark' | 'system'

export type AppSettings = {
  baseUrl: string
  persistApiKey: boolean
  apiKey?: string
  codexApiKey?: string
  textModel?: string
  themeMode?: ThemeMode
}

export type BackupSettings = Omit<AppSettings, 'apiKey' | 'codexApiKey' | 'persistApiKey'> & {
  persistApiKey: false
}

export type ModelOption = {
  id: string
  owned_by?: string
}

export type PromptOptimizationPreset =
  | 'general'
  | 'ecommerce'
  | 'product'
  | 'social'
  | 'brand'
  | 'character'

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
  onTaskUpdate?: (task: ImageGenerationTask) => void
}

export type ReferenceImage = {
  id: string
  name: string
  title?: string
  type: string
  dataUrl: string
}

export type StyleOption = {
  id: string
  category: string
  name: string
  styleJson: Record<string, unknown>
  previewUrl?: string
  sourceUrl?: string
  keywords: string[]
}

export type StyleLibraryResult = {
  root: string
  categories: Array<{ name: string; count: number }>
  styles: StyleOption[]
}

export type GeneratedImage = {
  src: string
  revisedPrompt?: string
}

export type ImageGenerationResult = {
  images: GeneratedImage[]
}

export type ImageGenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired'

export type ImageGenerationTask = {
  taskId: string
  status: ImageGenerationTaskStatus
  createdAt: number
  updatedAt: number
  completedAt?: number | null
  error?: string | null
  result?: {
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
  } | null
  pollAfterMs?: number
}

export type ManagedNewApiLoginPayload = {
  baseUrl: string
  username: string
  password: string
}

export type ManagedNewApiLoginResult = {
  baseUrl: string
  apiKey: string
  codexApiKey: string
  group: string
  model: string
  tokenName: string
  created: boolean
  codexGroup: string
  codexModel: string
  codexTokenName: string
  codexCreated: boolean
}

export type PromptOptimizationPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  mode: 'text' | 'image'
  optimizationPreset: PromptOptimizationPreset
}

export type SketchDescriptionPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  sketchDataUrl: string
}

export type CommerceMainPromptPayload = {
  baseUrl: string
  apiKey: string
  model: string
  description: string
  categoryPath?: string
  productImages: ReferenceImage[]
  styleImage: ReferenceImage
}

export type CommerceDetailPromptPayload = CommerceMainPromptPayload

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
  loginNewApi: (
    payload: ManagedNewApiLoginPayload
  ) => Promise<ManagedNewApiLoginResult>
  optimizePrompt: (payload: PromptOptimizationPayload) => Promise<string>
  describeSketch: (payload: SketchDescriptionPayload) => Promise<string>
  prepareCommerceMainPrompt: (payload: CommerceMainPromptPayload) => Promise<string>
  prepareCommerceDetailPrompt: (payload: CommerceDetailPromptPayload) => Promise<string>
  listStyles: () => Promise<StyleLibraryResult>
  generateImages: (
    payload: ImageGenerationPayload
  ) => Promise<ImageGenerationResult>
  openExternal: (url: string) => Promise<void>
}
