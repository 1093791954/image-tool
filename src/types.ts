export type ThemeMode = 'light' | 'dark' | 'system'

export type AppSettings = {
  baseUrl: string
  textBaseUrl?: string
  imageBaseUrl?: string
  persistApiKey: boolean
  apiKey?: string
  codexApiKey?: string
  imageBillingToken?: string
  newApiUserId?: number
  imageTokenId?: number
  imageTokenName?: string
  videoApiKey?: string
  videoTokenId?: number
  videoTokenName?: string
  videoModel?: string
  imageRetryCount?: number
  textModel?: string
  themeMode?: ThemeMode
}

export type BackupSettings = Omit<
  AppSettings,
  | 'apiKey'
  | 'codexApiKey'
  | 'imageBillingToken'
  | 'newApiUserId'
  | 'imageTokenId'
  | 'imageTokenName'
  | 'videoApiKey'
  | 'videoTokenId'
  | 'videoTokenName'
  | 'videoModel'
  | 'persistApiKey'
> & {
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
  promptTranslatorBaseUrl?: string
  promptTranslatorApiKey?: string
  promptTranslatorModel?: string
  mode?: 'text' | 'image'
  model: string
  prompt: string
  size: string
  quality: string
  count: number
  responseFormat: 'url' | 'b64_json'
  background?: 'auto' | 'opaque' | 'transparent'
  inputFidelity?: 'low' | 'high'
  retryCount?: number
  billingToken?: string
  billingUserId?: number
  billingTokenId?: number
  billingTokenName?: string
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

export type StyleSummary = Omit<StyleOption, 'styleJson'> & {
  styleJson?: Record<string, unknown>
}

export type StyleCategory = {
  name: string
  count: number
  href?: string
}

export type StyleLibraryResult = {
  root: string
  categories: StyleCategory[]
  styles: StyleSummary[]
}

export type StyleCategoryResult = {
  category: string
  styles: StyleOption[]
}

export type GeneratedImage = {
  src: string
  revisedPrompt?: string
}

export type ImageGenerationResult = {
  images: GeneratedImage[]
}

export type VideoGenerationPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  duration: number
  resolution: '480p' | '720p'
  ratio: string
  onTaskUpdate?: (task: VideoGenerationTask) => void
}

export type VideoGenerationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type VideoGenerationTask = {
  id: string
  status: VideoGenerationTaskStatus
  progress?: number
  content?: {
    video_url?: string
  }
  error?: string | { message?: string } | null
}

export type GeneratedVideo = {
  id: string
  src: string
  prompt: string
  model: string
  duration: number
  resolution: string
  ratio: string
  createdAt: number
}

export type VideoGenerationResult = {
  video: GeneratedVideo
}

export type ImageGenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired'

export type ImageGenerationTask = {
  taskId: string
  accessToken?: string
  status: ImageGenerationTaskStatus
  createdAt: number
  updatedAt: number
  completedAt?: number | null
  error?: string | null
  result?: {
    data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
  } | null
  pollAfterMs?: number
  fallbackUsed?: boolean
  fallbackReason?: string | null
  request?: {
    prompt?: string
    model?: string
    size?: string
    quality?: string
    mode?: 'text' | 'image'
    responseFormat?: 'url' | 'b64_json'
    count?: number
    canvasId?: string
    generateNodeId?: string
    referenceImageNames?: string[]
  }
}

export type ManagedNewApiLoginPayload = {
  baseUrl: string
  username: string
  password: string
}

export type ManagedNewApiLoginResult = {
  baseUrl: string
  userId: number
  codexApiKey: string
  codexTokenId: number
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

export type NegativePromptOptimizationPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  currentNegativePrompt?: string
}

export type SketchDescriptionPayload = {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  sketchDataUrl: string
  sketchWeight?: 'reference' | 'strict' | 'layout'
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
  generationTaskId?: string
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
  optimizeNegativePrompt: (payload: NegativePromptOptimizationPayload) => Promise<string>
  describeSketch: (payload: SketchDescriptionPayload) => Promise<string>
  prepareCommerceMainPrompt: (payload: CommerceMainPromptPayload) => Promise<string>
  prepareCommerceDetailPrompt: (payload: CommerceDetailPromptPayload) => Promise<string>
  listStyles: () => Promise<StyleLibraryResult>
  listStyleCategory: (category: StyleCategory) => Promise<StyleCategoryResult>
  generateImages: (
    payload: ImageGenerationPayload
  ) => Promise<ImageGenerationResult>
  generateVideo: (
    payload: VideoGenerationPayload
  ) => Promise<VideoGenerationResult>
  getImageTask: (taskId: string) => Promise<ImageGenerationTask>
  listImageTasks: () => Promise<ImageGenerationTask[]>
  openExternal: (url: string) => Promise<void>
}
