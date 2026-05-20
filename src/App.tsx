import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
  type IsValidConnection,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import {
  Copy,
  Download,
  Edit3,
  ExternalLink,
  KeyRound,
  Layers,
  LogIn,
  Loader2,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Save,
  ShoppingBag,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  clearImages,
  deleteImage,
  exportBackup,
  getSettings,
  importBackup,
  listImages,
  saveSettings,
  saveImages,
} from './storage'
import { bridge } from './bridge'
import {
  GalleryStrip,
  edgeTypes,
  nodeTypes,
  PROMPT_REFERENCE_HANDLE_IDS,
  type AssetNodeData,
  type BlueprintEdgeData,
  type GenerateNodeData,
  type PromptNodeData,
} from './workflowNodes'
import type {
  ImageGenerationTask,
  ImageGenerationTaskStatus,
  LocalImageRecord,
  ModelOption,
  PromptOptimizationPreset,
  ReferenceImage,
  ThemeMode,
} from './types'

const DEFAULT_BASE_URL = 'https://cc.api-corp.top'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_TEXT_MODEL = 'gpt-5.5'
const DEFAULT_PROMPT_OPTIMIZATION_PRESET: PromptOptimizationPreset = 'ecommerce'
const SHOP_URL = 'https://pay.ldxp.cn/shop/LY6AR08H'
const CONSOLE_URL = 'https://cc.api-corp.top/'

const sizes = ['1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024']
const qualities = ['auto', 'standard', 'hd', 'low', 'medium', 'high']
const counts = [1, 2, 3, 4]
const inputFidelities = ['low', 'high'] as const
const MAX_REFERENCE_IMAGES = 8
const themeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]
const promptOptimizationPresets: Array<{ value: PromptOptimizationPreset; label: string }> = [
  { value: 'ecommerce', label: '电商卖货' },
  { value: 'product', label: '产品质感' },
  { value: 'social', label: '社媒爆款' },
  { value: 'brand', label: '品牌海报' },
  { value: 'character', label: 'IP/角色' },
  { value: 'general', label: '通用增强' },
]

type WorkflowNode = Node<
  Record<string, unknown>,
  WorkflowNodeType
>

type WorkflowNodeType = 'asset' | 'prompt' | 'generate'
type WorkflowEdge = Edge<Partial<BlueprintEdgeData>, 'blueprint'>

type PaneMenu = {
  x: number
  y: number
  position: { x: number; y: number }
} | null

type WorkflowCanvas = {
  id: string
  name: string
  updatedAt: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  prompt: string
  promptOptimizationPreset: PromptOptimizationPreset
  generationMode: 'text' | 'image'
  referenceImages: ReferenceImage[]
  latestImageId?: string
  generationTaskId?: string
  generationTaskStatus?: ImageGenerationTaskStatus
  generationTaskUpdatedAt?: number
}

type PendingGenerationTaskRecord = {
  taskId: string
  prompt: string
  model: string
  size: string
  quality: string
  mode: 'text' | 'image'
  referenceImageNames?: string[]
  canvasId?: string
  createdAt: number
  status?: ImageGenerationTaskStatus
  updatedAt?: number
}

type StateUpdater<T> = T | ((current: T) => T)

const WORKFLOW_CANVASES_STORAGE_KEY = 'gpt-image-tools.workflow-canvases.v1'
const ACTIVE_CANVAS_STORAGE_KEY = 'gpt-image-tools.active-canvas.v1'
const PENDING_GENERATION_TASKS_STORAGE_KEY = 'gpt-image-tools.pending-generation-tasks.v1'

const initialWorkflowNodes: WorkflowNode[] = [
  { id: 'asset-1', type: 'asset', position: { x: -520, y: -130 }, data: {} },
  { id: 'prompt-1', type: 'prompt', position: { x: -520, y: 255 }, data: {} },
  { id: 'generate-1', type: 'generate', position: { x: 25, y: 45 }, data: {} },
]

const initialWorkflowEdges: WorkflowEdge[] = [
  {
    id: 'asset-1-prompt-1',
    type: 'blueprint',
    source: 'asset-1',
    target: 'prompt-1',
    sourceHandle: 'reference',
    targetHandle: 'reference-1',
    className: 'edge-blue',
    data: { label: '参考图 -> 文字描述' },
  },
  {
    id: 'prompt-1-generate-1',
    type: 'blueprint',
    source: 'prompt-1',
    target: 'generate-1',
    sourceHandle: 'prompt',
    targetHandle: 'prompt',
    animated: true,
    className: 'edge-violet',
    data: { label: '提示词 -> 图片生成' },
  },
]

function resolveUpdater<T>(updater: StateUpdater<T>, current: T): T {
  return typeof updater === 'function'
    ? (updater as (currentValue: T) => T)(current)
    : updater
}

function createLocalId(prefix: string) {
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)

  return `${prefix}-${Date.now()}-${randomId}`
}

function getWorkflowNodeReferenceImages(node?: Pick<WorkflowNode, 'data'> | null) {
  const value = node?.data?.referenceImages
  return Array.isArray(value) ? ensureReferenceTitles(value as ReferenceImage[]) : []
}

function cloneWorkflowNodes(nodes: WorkflowNode[], legacyReferenceImages: ReferenceImage[] = []) {
  const normalizedLegacyReferenceImages = ensureReferenceTitles(legacyReferenceImages)
  let hasStoredAssetReferences = false

  const clonedNodes = nodes.map((node) => {
    const referenceImages =
      node.type === 'asset' ? getWorkflowNodeReferenceImages(node) : []
    if (referenceImages.length > 0) hasStoredAssetReferences = true

    return {
      ...node,
      position: { ...node.position },
      data: referenceImages.length > 0 ? { referenceImages } : {},
    }
  })

  if (normalizedLegacyReferenceImages.length > 0 && !hasStoredAssetReferences) {
    const firstAssetIndex = clonedNodes.findIndex((node) => node.type === 'asset')
    if (firstAssetIndex >= 0) {
      clonedNodes[firstAssetIndex] = {
        ...clonedNodes[firstAssetIndex],
        data: { referenceImages: normalizedLegacyReferenceImages },
      }
    }
  }

  return clonedNodes
}

function cloneWorkflowEdges(edges: WorkflowEdge[]) {
  return edges.map((edge) => ({
    ...edge,
    data: { ...edge.data },
  }))
}

function isCanvasGenerating(canvas: WorkflowCanvas) {
  return canvas.generationTaskStatus === 'queued' || canvas.generationTaskStatus === 'running'
}

function normalizeReferenceTitle(value: string) {
  return value
    .trim()
    .replace(/^@+/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, '-')
    .replace(/[，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’]/g, '')
    .slice(0, 24)
}

function referenceTitleFromFileName(name: string, index: number) {
  return normalizeReferenceTitle(name) || `参考图${index + 1}`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ensureReferenceTitles(images: ReferenceImage[]) {
  return images.map((image, index) => ({
    ...image,
    title: normalizeReferenceTitle(image.title || image.name) || `参考图${index + 1}`,
  }))
}

function getCanvasReferenceImages(canvas?: Pick<WorkflowCanvas, 'nodes'> | null) {
  if (!canvas) return []

  const seen = new Set<string>()
  const images: ReferenceImage[] = []
  canvas.nodes.forEach((node) => {
    if (node.type !== 'asset') return
    getWorkflowNodeReferenceImages(node).forEach((image) => {
      if (seen.has(image.id)) return
      seen.add(image.id)
      images.push(image)
    })
  })

  return images
}

function normalizeWorkflowEdges(edges: WorkflowEdge[], nodes: WorkflowNode[]) {
  const promptNode = nodes.find((node) => node.type === 'prompt')
  const seen = new Set<string>()
  const normalizedEdges: WorkflowEdge[] = []

  edges.forEach((edge) => {
    let nextEdge = { ...edge, data: { ...edge.data } }

    if (
      nextEdge.sourceHandle === 'reference' &&
      nextEdge.targetHandle === 'image' &&
      promptNode
    ) {
      nextEdge = {
        ...nextEdge,
        id: `${nextEdge.source}-reference-${promptNode.id}-reference`,
        target: promptNode.id,
        targetHandle: PROMPT_REFERENCE_HANDLE_IDS[0] || 'reference-1',
        className: 'edge-blue',
        data: { ...nextEdge.data, label: '参考图 -> 文字描述' },
      }
    }

    if (
      nextEdge.sourceHandle === 'reference' &&
      nextEdge.targetHandle === 'reference' &&
      promptNode
    ) {
      nextEdge = {
        ...nextEdge,
        target: promptNode.id,
        targetHandle: PROMPT_REFERENCE_HANDLE_IDS[0] || 'reference-1',
        className: 'edge-blue',
        data: { ...nextEdge.data, label: '参考图 -> 文字描述' },
      }
    }

    if (nextEdge.targetHandle === 'image') return

    const key = `${nextEdge.source}-${nextEdge.sourceHandle}-${nextEdge.target}-${nextEdge.targetHandle}`
    if (seen.has(key)) return
    seen.add(key)
    normalizedEdges.push(nextEdge)
  })

  return normalizedEdges
}

function normalizePromptOptimizationPreset(value: unknown): PromptOptimizationPreset {
  return promptOptimizationPresets.some((preset) => preset.value === value)
    ? (value as PromptOptimizationPreset)
    : DEFAULT_PROMPT_OPTIMIZATION_PRESET
}

function createWorkflowCanvas(index: number, base?: WorkflowCanvas): WorkflowCanvas {
  const id = createLocalId('canvas')
  const now = Date.now()
  const baseNodes = cloneWorkflowNodes(
    base?.nodes || initialWorkflowNodes,
    base?.referenceImages || []
  )

  return {
    id,
    name: base ? `${base.name} 副本` : `画布 ${index}`,
    updatedAt: now,
    nodes: baseNodes,
    edges: normalizeWorkflowEdges(
      cloneWorkflowEdges(base?.edges || initialWorkflowEdges),
      baseNodes
    ),
    prompt: base?.prompt || '',
    promptOptimizationPreset: base?.promptOptimizationPreset || DEFAULT_PROMPT_OPTIMIZATION_PRESET,
    generationMode: base?.generationMode || 'text',
    referenceImages: [],
    latestImageId: base?.latestImageId,
  }
}

function normalizeStoredCanvases(value: unknown): WorkflowCanvas[] {
  if (!Array.isArray(value)) return []

  const canvases: WorkflowCanvas[] = []

  value.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const canvas = item as Partial<WorkflowCanvas>
    if (typeof canvas.id !== 'string' || typeof canvas.name !== 'string') return

    const legacyReferenceImages = Array.isArray(canvas.referenceImages)
      ? ensureReferenceTitles(canvas.referenceImages as ReferenceImage[])
      : []
    const normalizedNodes = Array.isArray(canvas.nodes)
      ? cloneWorkflowNodes(canvas.nodes as WorkflowNode[], legacyReferenceImages)
      : cloneWorkflowNodes(initialWorkflowNodes, legacyReferenceImages)
    const rawEdges = Array.isArray(canvas.edges)
      ? cloneWorkflowEdges(canvas.edges as WorkflowEdge[])
      : cloneWorkflowEdges(initialWorkflowEdges)

    canvases.push({
      id: canvas.id,
      name: canvas.name || `画布 ${index + 1}`,
      updatedAt: typeof canvas.updatedAt === 'number' ? canvas.updatedAt : Date.now(),
      nodes: normalizedNodes,
      edges: normalizeWorkflowEdges(rawEdges, normalizedNodes),
      prompt: typeof canvas.prompt === 'string' ? canvas.prompt : '',
      promptOptimizationPreset: normalizePromptOptimizationPreset(
        canvas.promptOptimizationPreset
      ),
      generationMode: canvas.generationMode === 'image' ? 'image' : 'text',
      referenceImages: [],
      latestImageId:
        typeof canvas.latestImageId === 'string' ? canvas.latestImageId : undefined,
      generationTaskId:
        typeof canvas.generationTaskId === 'string' ? canvas.generationTaskId : undefined,
      generationTaskStatus:
        canvas.generationTaskStatus === 'queued' ||
        canvas.generationTaskStatus === 'running' ||
        canvas.generationTaskStatus === 'completed' ||
        canvas.generationTaskStatus === 'failed' ||
        canvas.generationTaskStatus === 'expired'
          ? canvas.generationTaskStatus
          : undefined,
      generationTaskUpdatedAt:
        typeof canvas.generationTaskUpdatedAt === 'number'
          ? canvas.generationTaskUpdatedAt
          : undefined,
    })
  })

  return canvases
}

function loadWorkflowCanvases() {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_CANVASES_STORAGE_KEY)
    const stored = raw ? normalizeStoredCanvases(JSON.parse(raw)) : []
    const baseCanvases = stored.length > 0 ? stored : [createWorkflowCanvas(1)]
    return reconcileCanvasGenerationState(baseCanvases, loadPendingGenerationTasks())
  } catch {
    return [createWorkflowCanvas(1)]
  }
}

function loadActiveCanvasId() {
  try {
    return window.localStorage.getItem(ACTIVE_CANVAS_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function loadPendingGenerationTasks() {
  try {
    const raw = window.localStorage.getItem(PENDING_GENERATION_TASKS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PendingGenerationTaskRecord => {
      return (
        item &&
        typeof item === 'object' &&
        typeof item.taskId === 'string' &&
        typeof item.prompt === 'string' &&
        typeof item.model === 'string' &&
        typeof item.size === 'string' &&
        typeof item.quality === 'string' &&
        (item.mode === 'text' || item.mode === 'image') &&
        typeof item.createdAt === 'number'
      )
    })
  } catch {
    return []
  }
}

function reconcileCanvasGenerationState(
  canvases: WorkflowCanvas[],
  tasks: PendingGenerationTaskRecord[]
) {
  const taskByCanvasId = new Map(
    tasks
      .filter((task) => task.canvasId)
      .map((task) => [task.canvasId as string, task])
  )

  return canvases.map((canvas) => {
    const task = taskByCanvasId.get(canvas.id)
    if (!task) {
      return canvas
    }
    const status =
      task.status === 'queued' || task.status === 'running'
        ? task.status
        : task.status
          ? undefined
          : 'running'
    return {
      ...canvas,
      generationTaskId: status ? task.taskId : undefined,
      generationTaskStatus: status,
      generationTaskUpdatedAt: status ? task.updatedAt || task.createdAt : undefined,
    }
  })
}

function savePendingGenerationTasks(tasks: PendingGenerationTaskRecord[]) {
  window.localStorage.setItem(PENDING_GENERATION_TASKS_STORAGE_KEY, JSON.stringify(tasks))
}

function upsertPendingGenerationTask(record: PendingGenerationTaskRecord) {
  const current = loadPendingGenerationTasks()
  const next = current.filter((item) => item.taskId !== record.taskId)
  next.push(record)
  savePendingGenerationTasks(next)
}

function removePendingGenerationTask(taskId: string) {
  const next = loadPendingGenerationTasks().filter((item) => item.taskId !== taskId)
  savePendingGenerationTasks(next)
}

function removePendingGenerationTasksByCanvasId(canvasId: string) {
  const next = loadPendingGenerationTasks().filter((item) => item.canvasId !== canvasId)
  savePendingGenerationTasks(next)
}

function imageModelScore(model: ModelOption) {
  const id = model.id.toLowerCase()
  if (id === DEFAULT_MODEL) return 0
  if (id.includes('gpt-image')) return 1
  if (id.includes('dall-e')) return 2
  if (id.includes('imagen')) return 3
  if (id.includes('flux')) return 4
  if (id.includes('image')) return 5
  return 20
}

function extractReferenceMentions(prompt: string, knownTitles: string[] = []) {
  const orderedTitles = [...new Set(knownTitles.map((title) => normalizeReferenceTitle(title)).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  )

  if (orderedTitles.length > 0) {
    const mentions: string[] = []
    const pattern = new RegExp(`@(${orderedTitles.map(escapeRegExp).join('|')})`, 'g')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(prompt)) !== null) {
      const title = normalizeReferenceTitle(match[1] || '')
      if (title && !mentions.includes(title)) mentions.push(title)
    }
    if (mentions.length > 0) return mentions
  }

  const mentions: string[] = []
  const pattern = /@([^\s@，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt)) !== null) {
    const title = normalizeReferenceTitle(match[1] || '')
    if (title && !mentions.includes(title)) mentions.push(title)
  }
  return mentions
}

function resolvePromptReferenceImages(prompt: string, images: ReferenceImage[]) {
  const mentions = extractReferenceMentions(
    prompt,
    images.map((image) => image.title || image.name)
  )
  if (mentions.length === 0) return { mentions, images: [], missing: [] }

  const matchedImages: ReferenceImage[] = []
  const missing: string[] = []
  mentions.forEach((mention) => {
    const image = images.find((item) => normalizeReferenceTitle(item.title || item.name) === mention)
    if (image) matchedImages.push(image)
    else missing.push(mention)
  })

  return { mentions, images: matchedImages, missing }
}

function normalizeOptimizedPromptMentions(prompt: string, images: ReferenceImage[]) {
  const orderedTitles = [...new Set(images.map((image) => normalizeReferenceTitle(image.title || image.name)).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  )
  if (orderedTitles.length === 0) return prompt.trim()

  let next = prompt
  orderedTitles.forEach((title) => {
    const mention = `@${title}`
    const pattern = new RegExp(escapeRegExp(mention), 'g')
    next = next.replace(pattern, ` ${mention} `)
  })

  return next
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’])/g, '$1')
    .replace(/([，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’])\s+/g, '$1 ')
    .trim()
}

function downloadDataUrl(src: string, filename: string) {
  const link = document.createElement('a')
  link.href = src
  link.download = filename
  link.click()
}

function downloadJsonFile(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function newImageId(index: number) {
  return createLocalId(`image-${index}`)
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function estimateGenerationDurationMs(
  mode: 'text' | 'image',
  quality: string,
  count: number,
  referenceCount: number
) {
  const qualityExtra: Record<string, number> = {
    low: -10000,
    standard: 0,
    medium: 12000,
    high: 26000,
    hd: 30000,
    auto: 8000,
  }
  const base = mode === 'image' ? 72000 : 52000
  const countExtra = Math.max(0, count - 1) * 18000
  const referenceExtra = mode === 'image' ? Math.max(1, referenceCount) * 5000 : 0

  return Math.max(30000, base + (qualityExtra[quality] ?? 8000) + countExtra + referenceExtra)
}

function estimateProgress(elapsedMs: number, estimatedMs: number) {
  const ratio = Math.min(elapsedMs / estimatedMs, 1)
  const easedRatio = 1 - Math.pow(1 - ratio, 2.25)
  return Math.max(3, Math.min(96, Math.round(easedRatio * 96)))
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

function progressStage(progress: number, mode: 'text' | 'image') {
  if (progress < 12) return '提交生成请求'
  if (mode === 'image' && progress < 28) return '上传参考图'
  if (progress < 72) return mode === 'image' ? '根据参考图生成' : '模型生成中'
  if (progress < 96) return '等待结果返回'
  return '即将完成'
}

function taskStatusLabel(status: ImageGenerationTask['status']) {
  if (status === 'queued') return '任务已提交服务器后台'
  if (status === 'running') return '服务器正在生成，结果会暂存在缓存区'
  if (status === 'completed') return '服务器已返回结果，正在保存到本地'
  if (status === 'expired') return '服务器临时缓存已过期'
  return '服务器后台生成失败'
}

async function readGenerationTask(taskId: string) {
  const response = await fetch(`/api/openai/tasks/${encodeURIComponent(taskId)}`)
  const text = await response.text()
  let body: { success?: boolean; message?: string; data?: ImageGenerationTask } | null = null

  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('查询服务器任务状态失败：返回了无效数据')
    }
  }

  if (!response.ok) {
    throw new Error(body?.message || `查询服务器任务状态失败：HTTP ${response.status}`)
  }
  if (!body?.success || !body.data) {
    throw new Error(body?.message || '查询服务器任务状态失败')
  }

  return body.data
}

export function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [codexApiKey, setCodexApiKey] = useState('')
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false)
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [isNewApiLoggingIn, setIsNewApiLoggingIn] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL)
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>('b64_json')
  const [inputFidelity, setInputFidelity] = useState<'low' | 'high'>('high')
  const [canvases, setCanvases] = useState<WorkflowCanvas[]>(loadWorkflowCanvases)
  const [activeCanvasId, setActiveCanvasId] = useState(loadActiveCanvasId)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isOptimizingPrompt, setIsOptimizingPrompt] = useState(false)
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null)
  const [generationProgress, setGenerationProgress] = useState(0)
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0)
  const [images, setImages] = useState<LocalImageRecord[]>([])
  const [previewImage, setPreviewImage] = useState<LocalImageRecord | null>(null)
  const [status, setStatus] = useState('未连接')
  const [error, setError] = useState('')
  const [paneMenu, setPaneMenu] = useState<PaneMenu>(null)
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<WorkflowNode, WorkflowEdge> | null>(null)
  const generationTaskIdsRef = useRef(new Set<string>())

  const activeCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === activeCanvasId) || canvases[0],
    [activeCanvasId, canvases]
  )
  const nodes = activeCanvas?.nodes || []
  const edges = activeCanvas?.edges || []
  const prompt = activeCanvas?.prompt || ''
  const promptOptimizationPreset =
    activeCanvas?.promptOptimizationPreset || DEFAULT_PROMPT_OPTIMIZATION_PRESET
  const generationMode = activeCanvas?.generationMode || 'text'
  const referenceImages = getCanvasReferenceImages(activeCanvas)
  const activeCanvasGenerating = activeCanvas ? isCanvasGenerating(activeCanvas) : false
  const latestImage =
    images.find((image) => image.id === activeCanvas?.latestImageId) || null

  const updateActiveCanvas = useCallback(
    (updater: (canvas: WorkflowCanvas) => WorkflowCanvas) => {
      setCanvases((currentCanvases) =>
        currentCanvases.map((canvas) =>
          canvas.id === activeCanvas?.id
            ? { ...updater(canvas), updatedAt: Date.now() }
            : canvas
        )
      )
    },
    [activeCanvas?.id]
  )

  const setNodes = useCallback(
    (updater: StateUpdater<WorkflowNode[]>) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        nodes: resolveUpdater(updater, canvas.nodes),
      }))
    },
    [updateActiveCanvas]
  )

  const setEdges = useCallback(
    (updater: StateUpdater<WorkflowEdge[]>) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        edges: resolveUpdater(updater, canvas.edges),
      }))
    },
    [updateActiveCanvas]
  )

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      updateActiveCanvas((canvas) => ({ ...canvas, prompt: nextPrompt }))
    },
    [updateActiveCanvas]
  )

  const setPromptOptimizationPreset = useCallback(
    (nextPreset: PromptOptimizationPreset) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        promptOptimizationPreset: nextPreset,
      }))
    },
    [updateActiveCanvas]
  )

  const setGenerationMode = useCallback(
    (nextMode: 'text' | 'image') => {
      updateActiveCanvas((canvas) => ({ ...canvas, generationMode: nextMode }))
    },
    [updateActiveCanvas]
  )

  const setAssetNodeReferenceImages = useCallback(
    (nodeId: string, updater: StateUpdater<ReferenceImage[]>) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        referenceImages: [],
        nodes: canvas.nodes.map((node) => {
          if (node.id !== nodeId || node.type !== 'asset') return node

          const currentImages = getWorkflowNodeReferenceImages(node)
          const nextImages = ensureReferenceTitles(resolveUpdater(updater, currentImages))

          return {
            ...node,
            data: nextImages.length > 0 ? { referenceImages: nextImages } : {},
          }
        }),
      }))
    },
    [updateActiveCanvas]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowNode>[]) => {
      setNodes((currentNodes) => applyNodeChanges(changes, currentNodes))
    },
    [setNodes]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowEdge>[]) => {
      setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges))
    },
    [setEdges]
  )

  const sortedModels = useMemo(
    () =>
      [...models].sort((a, b) => {
        const diff = imageModelScore(a) - imageModelScore(b)
        return diff || a.id.localeCompare(b.id)
      }),
    [models]
  )

  const estimatedGenerationMs = useMemo(
    () =>
      estimateGenerationDurationMs(
        generationMode,
        quality,
        count,
        referenceImages.length
      ),
    [count, generationMode, quality, referenceImages.length]
  )

  const remainingSeconds = Math.max(
    0,
    Math.ceil((estimatedGenerationMs - generationElapsedSeconds * 1000) / 1000)
  )

  useEffect(() => {
    void getSettings().then((settings) => {
      setBaseUrl(settings.baseUrl || DEFAULT_BASE_URL)
      setPersistApiKey(Boolean(settings.persistApiKey))
      setThemeMode(settings.themeMode || 'system')
      setTextModel(settings.textModel || DEFAULT_TEXT_MODEL)
      if (settings.persistApiKey && settings.apiKey) setApiKey(settings.apiKey)
      if (settings.persistApiKey && settings.codexApiKey) setCodexApiKey(settings.codexApiKey)
    })
    void refreshImages()
  }, [])

  useEffect(() => {
    void resumePersistedGenerationTasks()
  }, [])

  useEffect(() => {
    if (!activeCanvas && canvases[0]) {
      setActiveCanvasId(canvases[0].id)
      return
    }

    if (activeCanvas && activeCanvas.id !== activeCanvasId) {
      setActiveCanvasId(activeCanvas.id)
    }
  }, [activeCanvas, activeCanvasId, canvases])

  useEffect(() => {
    window.localStorage.setItem(WORKFLOW_CANVASES_STORAGE_KEY, JSON.stringify(canvases))
  }, [canvases])

  useEffect(() => {
    if (activeCanvas?.id) {
      window.localStorage.setItem(ACTIVE_CANVAS_STORAGE_KEY, activeCanvas.id)
    }
  }, [activeCanvas?.id])

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const nextTheme =
        themeMode === 'system' ? (query.matches ? 'dark' : 'light') : themeMode
      setResolvedTheme(nextTheme)
      document.documentElement.dataset.theme = nextTheme
      document.documentElement.dataset.themeMode = themeMode
    }

    applyTheme()
    query.addEventListener('change', applyTheme)
    return () => query.removeEventListener('change', applyTheme)
  }, [themeMode])

  useEffect(() => {
    if (!previewImage) return

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreviewImage(null)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewImage])

  useEffect(() => {
    if (!isGenerating || !generationStartedAt) return

    const updateProgress = () => {
      const elapsedMs = Date.now() - generationStartedAt
      setGenerationElapsedSeconds(Math.floor(elapsedMs / 1000))
      setGenerationProgress(estimateProgress(elapsedMs, estimatedGenerationMs))
    }

    updateProgress()
    const timer = window.setInterval(updateProgress, 500)
    return () => window.clearInterval(timer)
  }, [estimatedGenerationMs, generationStartedAt, isGenerating])

  useEffect(() => {
    if (!flowInstance) return

    let resizeTimer = 0
    const refit = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        flowInstance.fitView({
          padding: window.innerWidth > 1500 ? 0.18 : 0.1,
          duration: 260,
        })
      }, 120)
    }

    refit()
    window.addEventListener('resize', refit)
    return () => {
      window.clearTimeout(resizeTimer)
      window.removeEventListener('resize', refit)
    }
  }, [activeCanvas?.id, flowInstance, resolvedTheme])

  async function refreshImages() {
    setImages(await listImages())
  }

  function savePendingGenerationTaskRecord(
    task: ImageGenerationTask,
    context: {
      prompt: string
      model: string
      size: string
      quality: string
      mode: 'text' | 'image'
      referenceImageNames?: string[]
      canvasId?: string
    }
  ) {
    upsertPendingGenerationTask({
      taskId: task.taskId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      status: task.status,
      ...context,
    })
  }

  function clearPendingGenerationTaskRecord(taskId: string) {
    removePendingGenerationTask(taskId)
  }

  function setCanvasGenerationTask(
    canvasId: string,
    task: Pick<ImageGenerationTask, 'taskId' | 'status' | 'updatedAt' | 'createdAt'> | null
  ) {
    setCanvases((currentCanvases) =>
      currentCanvases.map((canvas) =>
        canvas.id === canvasId
          ? {
              ...canvas,
              generationTaskId:
                task && (task.status === 'queued' || task.status === 'running')
                  ? task.taskId
                  : undefined,
              generationTaskStatus:
                task && (task.status === 'queued' || task.status === 'running')
                  ? task.status
                  : undefined,
              generationTaskUpdatedAt:
                task && (task.status === 'queued' || task.status === 'running')
                  ? task.updatedAt || task.createdAt
                  : undefined,
              updatedAt: Date.now(),
            }
          : canvas
      )
    )
  }

  function clearCanvasGenerationTask(canvasId: string) {
    setCanvasGenerationTask(canvasId, null)
  }

  function buildLocalImageRecords(
    images: Array<{ src: string; revisedPrompt?: string }>,
    context: {
      prompt: string
      model: string
      size: string
      quality: string
      mode: 'text' | 'image'
      referenceImageNames?: string[]
    }
  ) {
    const createdAt = Date.now()
    return images.map((item, index) => ({
      id: newImageId(index),
      src: item.src,
      prompt: context.prompt,
      model: context.model,
      size: context.size,
      quality: context.quality,
      createdAt,
      revisedPrompt: item.revisedPrompt,
      mode: context.mode,
      referenceImageNames: context.referenceImageNames,
    }))
  }

  async function persistCompletedTaskResult(
    taskId: string,
    generatedImages: Array<{ src: string; revisedPrompt?: string }>,
    context: {
      prompt: string
      model: string
      size: string
      quality: string
      mode: 'text' | 'image'
      referenceImageNames?: string[]
      canvasId?: string
    }
  ) {
    const records = buildLocalImageRecords(generatedImages, context)
    await saveImages(records)
    if (context.canvasId && records[0]) {
      setCanvases((currentCanvases) =>
        currentCanvases.map((canvas) =>
          canvas.id === context.canvasId
            ? {
                ...canvas,
                latestImageId: records[0].id,
                generationTaskId: undefined,
                generationTaskStatus: undefined,
                generationTaskUpdatedAt: undefined,
                updatedAt: Date.now(),
              }
            : canvas
        )
      )
    }
    await refreshImages()
    clearPendingGenerationTaskRecord(taskId)
    return records
  }

  async function urlToDataUrlLocal(url: string) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`)
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  async function taskResultToGeneratedImages(taskResult: ImageGenerationTask['result']) {
    const images: Array<{ src: string; revisedPrompt?: string }> = []
    for (const item of taskResult?.data || []) {
      if (item.b64_json) {
        images.push({
          src: `data:image/png;base64,${item.b64_json}`,
          revisedPrompt: item.revised_prompt,
        })
      } else if (item.url) {
        images.push({
          src: await urlToDataUrlLocal(item.url),
          revisedPrompt: item.revised_prompt,
        })
      }
    }
    return images
  }

  async function resumePersistedGenerationTasks() {
    const pendingTasks = loadPendingGenerationTasks()
    for (const task of pendingTasks) {
      if (generationTaskIdsRef.current.has(task.taskId)) continue
      generationTaskIdsRef.current.add(task.taskId)
      if (!task.canvasId) {
        clearPendingGenerationTaskRecord(task.taskId)
        generationTaskIdsRef.current.delete(task.taskId)
        continue
      }

      try {
        setIsGenerating(true)
        setGenerationStartedAt(task.createdAt)
        setGenerationElapsedSeconds(0)
        setGenerationProgress(8)
        setStatus(taskStatusLabel('queued'))
        setCanvasGenerationTask(task.canvasId, {
          taskId: task.taskId,
          status: task.status || 'queued',
          updatedAt: task.updatedAt || task.createdAt,
          createdAt: task.createdAt,
        })

        let currentTask = await readGenerationTask(task.taskId)
        while (currentTask.status === 'queued' || currentTask.status === 'running') {
          setStatus(taskStatusLabel(currentTask.status))
          setGenerationProgress(currentTask.status === 'running' ? 68 : 24)
          setCanvasGenerationTask(task.canvasId, currentTask)
          await new Promise((resolve) => window.setTimeout(resolve, currentTask.pollAfterMs || 1500))
          currentTask = await readGenerationTask(task.taskId)
        }

        if (currentTask.status === 'failed' || currentTask.status === 'expired') {
          clearPendingGenerationTaskRecord(task.taskId)
          clearCanvasGenerationTask(task.canvasId)
          setError(currentTask.error || '服务器后台生图失败')
          setStatus(taskStatusLabel(currentTask.status))
          continue
        }

        if (!currentTask.result) {
          clearPendingGenerationTaskRecord(task.taskId)
          setError('服务器后台任务没有返回生成结果')
          setStatus('生成失败')
          continue
        }

        const generatedImages = await taskResultToGeneratedImages(currentTask.result)
        await persistCompletedTaskResult(task.taskId, generatedImages, task)
        setGenerationProgress(100)
        setStatus('服务器缓存结果已恢复到本地图库')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        clearCanvasGenerationTask(task.canvasId)
        clearPendingGenerationTaskRecord(task.taskId)
        setStatus('恢复后台任务失败')
      } finally {
        generationTaskIdsRef.current.delete(task.taskId)
        setIsGenerating(false)
        setGenerationStartedAt(null)
      }
    }
  }

  async function handleSaveSettings() {
    await saveSettings({ baseUrl, persistApiKey, apiKey, codexApiKey, textModel, themeMode })
    setStatus(persistApiKey ? '设置已保存' : '设置已保存，API Key 未落盘')
  }

  async function handleThemeChange(nextThemeMode: ThemeMode) {
    setThemeMode(nextThemeMode)
    await saveSettings({
      baseUrl,
      persistApiKey,
      apiKey,
      codexApiKey,
      textModel,
      themeMode: nextThemeMode,
    })
    setStatus('主题已切换')
  }

  async function handleOpenShop() {
    await bridge.openExternal(SHOP_URL)
  }

  async function handleOpenConsole() {
    await bridge.openExternal(CONSOLE_URL)
  }

  async function handleExportBackup() {
    const backup = await exportBackup()
    const date = new Date(backup.exportedAt).toISOString().slice(0, 10)
    downloadJsonFile(backup, `gpt-image-tools-backup-${date}.json`)
    setStatus('本地备份已导出')
  }

  async function handleImportBackup(file: File) {
    try {
      const text = await file.text()
      const importedCount = await importBackup(JSON.parse(text))
      const settings = await getSettings()
      setBaseUrl(settings.baseUrl || DEFAULT_BASE_URL)
      setPersistApiKey(Boolean(settings.persistApiKey))
      setThemeMode(settings.themeMode || 'system')
      setTextModel(settings.textModel || DEFAULT_TEXT_MODEL)
      setApiKey('')
      setCodexApiKey('')
      await refreshImages()
      setStatus(`已导入 ${importedCount} 张图片，API Key 未从备份恢复`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('导入备份失败')
    }
  }

  async function addReferenceFiles(nodeId: string, files: FileList | File[]) {
    const imageFiles = [...files].filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const nodeReferenceImages = getWorkflowNodeReferenceImages(
      nodes.find((node) => node.id === nodeId)
    )
    const remainingSlots = Math.max(0, MAX_REFERENCE_IMAGES - nodeReferenceImages.length)
    const selectedFiles = imageFiles.slice(0, remainingSlots)
    const nextImages = await Promise.all(
      selectedFiles.map(async (file, index) => ({
        id: createLocalId('reference'),
        name: file.name,
        title: referenceTitleFromFileName(file.name, nodeReferenceImages.length + index),
        type: file.type || 'image/png',
        dataUrl: await fileToDataUrl(file),
      }))
    )

    setAssetNodeReferenceImages(nodeId, (current) => [...current, ...nextImages])
    setGenerationMode('image')
    if (imageFiles.length > remainingSlots) setStatus(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图`)
  }

  function removeReferenceImage(nodeId: string, id: string) {
    const willRemoveLastReference =
      referenceImages.length <= 1 && referenceImages.some((image) => image.id === id)
    setAssetNodeReferenceImages(nodeId, (current) =>
      current.filter((image) => image.id !== id)
    )
    if (willRemoveLastReference) setGenerationMode('text')
  }

  function updateReferenceImageTitle(nodeId: string, id: string, title: string) {
    setAssetNodeReferenceImages(nodeId, (current) =>
      current.map((image) =>
        image.id === id ? { ...image, title: normalizeReferenceTitle(title) } : image
      )
    )
  }

  async function handleFetchModels() {
    setError('')
    setStatus('正在获取模型...')
    setIsLoadingModels(true)

    try {
      const nextModels = await bridge.listModels({ baseUrl, apiKey })
      setModels(nextModels)

      const preferred =
        nextModels.find((item) => item.id === DEFAULT_MODEL) ||
        [...nextModels].sort((a, b) => imageModelScore(a) - imageModelScore(b))[0]

      if (preferred) setModel(preferred.id)
      setStatus(`已获取 ${nextModels.length} 个模型`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('获取模型失败')
    } finally {
      setIsLoadingModels(false)
    }
  }

  async function handleNewApiLogin() {
    if (!loginUsername.trim() || !loginPassword) {
      setError('请输入中转站账号和密码')
      return
    }

    setError('')
    setStatus('正在登录中转站...')
    setIsNewApiLoggingIn(true)

    try {
      const result = await bridge.loginNewApi({
        baseUrl: DEFAULT_BASE_URL,
        username: loginUsername,
        password: loginPassword,
      })

      setBaseUrl(result.baseUrl)
      setApiKey(result.apiKey)
      setCodexApiKey(result.codexApiKey)
      setPersistApiKey(true)
      setModel(result.model || DEFAULT_MODEL)
      setTextModel(result.codexModel || DEFAULT_TEXT_MODEL)
      await saveSettings({
        baseUrl: result.baseUrl,
        persistApiKey: true,
        apiKey: result.apiKey,
        codexApiKey: result.codexApiKey,
        textModel: result.codexModel || DEFAULT_TEXT_MODEL,
        themeMode,
      })
      setLoginPassword('')
      setIsLoginDialogOpen(false)
      setStatus(
        `${result.created ? '已创建' : '已启用'} ${result.group}，${result.codexCreated ? '已创建' : '已启用'} ${result.codexGroup}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('中转站登录失败')
    } finally {
      setIsNewApiLoggingIn(false)
    }
  }

  async function handleOptimizePrompt() {
    const currentPrompt = prompt.trim()
    if (!currentPrompt) {
      setError('请先输入需要优化的提示词')
      return
    }
    if (!codexApiKey) {
      setError('请先点击连接配置里的登录，获取 codex 满血高速 分组秘钥')
      setStatus('缺少提示词优化秘钥')
      return
    }

    setError('')
    setStatus('正在优化提示词...')
    setIsOptimizingPrompt(true)

    try {
      const optimizedPrompt = await bridge.optimizePrompt({
        baseUrl,
        apiKey: codexApiKey,
        model: textModel.trim() || DEFAULT_TEXT_MODEL,
        prompt: currentPrompt,
        mode: generationMode,
        optimizationPreset: promptOptimizationPreset,
      })
      setPrompt(normalizeOptimizedPromptMentions(optimizedPrompt, referenceImages))
      setStatus('提示词已优化')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('提示词优化失败')
    } finally {
      setIsOptimizingPrompt(false)
    }
  }

  async function handleGenerate() {
    const finalPrompt = prompt.trim()
    const generatingCanvasId = activeCanvas?.id
    if (!finalPrompt) {
      setError('请先输入提示词')
      return
    }
    const resolvedReferences = resolvePromptReferenceImages(finalPrompt, referenceImages)
    const hasReferencePromptConnection = edges.some(
      (edge) =>
        edge.sourceHandle === 'reference' &&
        (edge.targetHandle === 'reference' || edge.targetHandle?.startsWith('reference-')) &&
        nodes.find((node) => node.id === edge.source)?.type === 'asset' &&
        nodes.find((node) => node.id === edge.target)?.type === 'prompt'
    )
    if (resolvedReferences.mentions.length > 0 && !hasReferencePromptConnection) {
      setError('请先把参考图片节点连接到文字描述节点，再使用 @引用参考图')
      return
    }
    if (resolvedReferences.missing.length > 0) {
      setError(`没有找到这些 @参考图：${resolvedReferences.missing.join('、')}`)
      return
    }
    const effectiveGenerationMode: 'text' | 'image' =
      resolvedReferences.images.length > 0 ? 'image' : 'text'
    const referenceImageNames =
      effectiveGenerationMode === 'image'
        ? resolvedReferences.images.map((image) => image.title || image.name)
        : undefined
    const generationContext = {
      prompt: finalPrompt,
      model,
      size,
      quality,
      mode: effectiveGenerationMode,
      referenceImageNames,
      canvasId: generatingCanvasId || undefined,
    }

    setError('')
    setStatus(
      effectiveGenerationMode === 'image'
        ? `正在根据 ${resolvedReferences.images.length} 张 @参考图提交后台任务...`
        : '正在提交后台生图任务...'
    )
    setGenerationStartedAt(Date.now())
    setGenerationElapsedSeconds(0)
    setGenerationProgress(5)
    setIsGenerating(true)

    let currentTaskId = ''

    try {
      const result = await bridge.generateImages({
        baseUrl,
        apiKey,
        mode: effectiveGenerationMode,
        model,
        prompt: finalPrompt,
        size,
        quality,
        count,
        responseFormat,
        inputFidelity,
        referenceImages:
          effectiveGenerationMode === 'image' ? resolvedReferences.images : undefined,
        onTaskUpdate: (task) => {
          currentTaskId = task.taskId
          generationTaskIdsRef.current.add(task.taskId)
          savePendingGenerationTaskRecord(task, generationContext)
          if (generationContext.canvasId) {
            if (task.status === 'queued' || task.status === 'running') {
              setCanvasGenerationTask(generationContext.canvasId, task)
            } else {
              clearCanvasGenerationTask(generationContext.canvasId)
            }
          }
          setStatus(taskStatusLabel(task.status))
          if (task.status === 'queued') setGenerationProgress(18)
          if (task.status === 'running') setGenerationProgress(66)
          if (task.status === 'completed') setGenerationProgress(94)
          if (task.status === 'failed' || task.status === 'expired') setGenerationProgress(0)
        },
      })

      if (!currentTaskId) {
        throw new Error('任务提交成功，但没有返回任务 ID')
      }

      const records = await persistCompletedTaskResult(
        currentTaskId,
        result.images,
        generationContext
      )
      setGenerationProgress(100)
      setStatus(`已生成 ${records.length} 张图片，服务器缓存已同步到本地`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (currentTaskId) clearPendingGenerationTaskRecord(currentTaskId)
      if (generatingCanvasId) clearCanvasGenerationTask(generatingCanvasId)
      setStatus('生成失败')
    } finally {
      if (currentTaskId) generationTaskIdsRef.current.delete(currentTaskId)
      setIsGenerating(false)
      setGenerationStartedAt(null)
    }
  }

  async function handleDeleteImage(id: string) {
    await deleteImage(id)
    await refreshImages()
  }

  async function handleClearImages() {
    await clearImages()
    await refreshImages()
  }

  function handleDownloadImage(image: LocalImageRecord, index = 0) {
    downloadDataUrl(image.src, `gpt-image-${index + 1}.png`)
  }

  function handleCreateCanvas() {
    const nextCanvas = createWorkflowCanvas(canvases.length + 1)
    setCanvases((currentCanvases) => [...currentCanvases, nextCanvas])
    setActiveCanvasId(nextCanvas.id)
    setPaneMenu(null)
    setStatus(`${nextCanvas.name} 已创建`)
  }

  function handleDuplicateCanvas(id: string) {
    const sourceCanvas = canvases.find((canvas) => canvas.id === id)
    if (!sourceCanvas) return

    const nextCanvas = createWorkflowCanvas(canvases.length + 1, sourceCanvas)
    setCanvases((currentCanvases) => [...currentCanvases, nextCanvas])
    setActiveCanvasId(nextCanvas.id)
    setPaneMenu(null)
    setStatus(`${sourceCanvas.name} 已复制`)
  }

  function handleDeleteCanvas(id: string) {
    if (canvases.length <= 1) {
      setStatus('至少保留一个画布')
      return
    }

    const deletedIndex = canvases.findIndex((canvas) => canvas.id === id)
    const nextCanvases = canvases.filter((canvas) => canvas.id !== id)
    setCanvases(nextCanvases)
    removePendingGenerationTasksByCanvasId(id)

    if (id === activeCanvasId) {
      const nextActive =
        nextCanvases[Math.max(0, deletedIndex - 1)] || nextCanvases[0]
      if (nextActive) setActiveCanvasId(nextActive.id)
    }

    setPaneMenu(null)
    setStatus('画布已删除')
  }

  function handleRenameCanvas(id: string, nextName: string) {
    const normalizedName = nextName.slice(0, 32)
    setCanvases((currentCanvases) =>
      currentCanvases.map((canvas) =>
        canvas.id === id
          ? { ...canvas, name: normalizedName, updatedAt: Date.now() }
          : canvas
      )
    )
  }

  function handleCommitCanvasName(id: string) {
    const canvas = canvases.find((item) => item.id === id)
    if (!canvas) return

    const nextName = canvas.name.trim() || '未命名画布'
    if (nextName !== canvas.name) handleRenameCanvas(id, nextName)
    setStatus(`${nextName} 已命名`)
  }

  function stopCanvasNameShortcut(event: ReactKeyboardEvent<HTMLInputElement>) {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    }
  }

  const deleteWorkflowEdge = useCallback(
    (id: string) => {
      setEdges((currentEdges) => currentEdges.filter((edge) => edge.id !== id))
      setStatus('连接已删除')
    },
    [setEdges]
  )

  const deleteWorkflowNode = useCallback(
    (id: string) => {
      setNodes((currentNodes) => currentNodes.filter((node) => node.id !== id))
      setEdges((currentEdges) =>
        currentEdges.filter((edge) => edge.source !== id && edge.target !== id)
      )
      setStatus('节点已删除')
    },
    [setEdges, setNodes]
  )

  const canGenerate =
    !activeCanvasGenerating && Boolean(apiKey && baseUrl && model && prompt.trim())

  function nodeDataFor(node: WorkflowNode): WorkflowNode['data'] {
    const type = node.type as WorkflowNodeType

    if (type === 'asset') {
      const nodeReferenceImages = getWorkflowNodeReferenceImages(node)

      return {
        onDeleteNode: deleteWorkflowNode,
        referenceImages: nodeReferenceImages,
        addReferenceFiles: (files: FileList | File[]) => addReferenceFiles(node.id, files),
        removeReferenceImage: (id: string) => removeReferenceImage(node.id, id),
        updateReferenceImageTitle: (id: string, title: string) =>
          updateReferenceImageTitle(node.id, id, title),
      }
    }

    if (type === 'prompt') {
      return {
        onDeleteNode: deleteWorkflowNode,
        prompt,
        setPrompt,
        referenceImages,
        optimizationPreset: promptOptimizationPreset,
        optimizationPresets: promptOptimizationPresets,
        setOptimizationPreset: setPromptOptimizationPreset,
        generationMode,
        isOptimizingPrompt,
        canOptimizePrompt: Boolean(prompt.trim()) && Boolean(codexApiKey) && !isOptimizingPrompt,
        onOptimizePrompt: handleOptimizePrompt,
      }
    }

    if (type === 'generate') {
      return {
        onDeleteNode: deleteWorkflowNode,
        model,
        sortedModels,
        setModel,
        size,
        sizes,
        setSize,
        quality,
        qualities,
        setQuality,
        count,
        counts,
        setCount,
        responseFormat,
        setResponseFormat,
        inputFidelity,
        inputFidelities,
        setInputFidelity,
        generationMode,
        isGenerating: activeCanvasGenerating,
        canGenerate,
        onGenerate: handleGenerate,
        progressLabel: progressStage(generationProgress, generationMode),
        progressDetail: `已等待 ${formatDuration(generationElapsedSeconds)} · 预计还需 ${formatDuration(remainingSeconds)}`,
        generationProgress,
        image: latestImage,
        onPreview: setPreviewImage,
        onDownload: handleDownloadImage,
      }
    }

    return { onDeleteNode: deleteWorkflowNode }
  }

  const workflowNodes = useMemo<WorkflowNode[]>(
    () =>
      nodes.map((node) => ({
        ...node,
        data: nodeDataFor(node),
      })),
    [
      nodes,
      generationMode,
      referenceImages,
      prompt,
      promptOptimizationPreset,
      codexApiKey,
      textModel,
      isOptimizingPrompt,
      model,
      sortedModels,
      size,
      quality,
      count,
      responseFormat,
      inputFidelity,
      activeCanvasGenerating,
      canGenerate,
      generationProgress,
      generationElapsedSeconds,
      remainingSeconds,
      latestImage,
      deleteWorkflowNode,
      setPromptOptimizationPreset,
    ]
  )

  const workflowEdges = useMemo<WorkflowEdge[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: 'blueprint',
        data: {
          ...edge.data,
          label:
            edge.data?.label ||
            (edge.source.startsWith('asset')
              ? '参考图 -> 文字描述'
              : edge.source.startsWith('generate')
                ? '生成图 -> 参考图'
                : '提示词 -> 图片生成'),
          onDelete: deleteWorkflowEdge,
        },
        animated:
          edge.source.includes('prompt') ||
          (activeCanvasGenerating && edge.source.includes('generate')) ||
          edge.source.includes('asset'),
      })),
    [activeCanvasGenerating, deleteWorkflowEdge, edges]
  )

  const isValidConnection: IsValidConnection<WorkflowEdge> = useCallback(
    (connection) => {
      const source = nodes.find((node) => node.id === connection.source)
      const target = nodes.find((node) => node.id === connection.target)
      if (!source || !target) return false
      if (source.id === target.id) return false

      if (source.type === 'asset') {
        const targetHandle = connection.targetHandle || ''
        return (
          target.type === 'prompt' &&
          connection.sourceHandle === 'reference' &&
          PROMPT_REFERENCE_HANDLE_IDS.includes(targetHandle)
        )
      }

      if (source.type === 'prompt') {
        return (
          target.type === 'generate' &&
          connection.sourceHandle === 'prompt' &&
          connection.targetHandle === 'prompt'
        )
      }

      return false
    },
    [nodes]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) {
        setStatus('这个端口不能这样连接')
        return
      }

      const sourceType = connection.source?.split('-')[0]
      const label =
        sourceType === 'asset' ? '参考图 -> 文字描述' : '提示词 -> 图片生成'
      const className =
        sourceType === 'asset'
          ? 'edge-blue'
          : sourceType === 'prompt'
            ? 'edge-violet'
            : 'edge-green'

      setEdges((currentEdges) => {
        const withoutPreviousInput = currentEdges.filter(
          (edge) =>
            !(
              edge.target === connection.target &&
              edge.targetHandle === connection.targetHandle
            )
        )

        return addEdge(
          {
            ...connection,
            type: 'blueprint',
            id: `${connection.source}-${connection.sourceHandle || 'out'}-${connection.target}-${connection.targetHandle || 'in'}-${Date.now()}`,
            className,
            animated: sourceType === 'prompt',
            data: { label },
          },
          withoutPreviousInput
        )
      })
      setPaneMenu(null)
      setStatus(`${label} 已连接`)
    },
    [isValidConnection, setEdges]
  )

  const handlePaneContextMenu = useCallback(
    (event: ReactMouseEvent<Element> | globalThis.MouseEvent) => {
      event.preventDefault()
      const currentTarget =
        'currentTarget' in event && event.currentTarget
          ? (event.currentTarget as HTMLDivElement)
          : null
      const bounds = currentTarget?.getBoundingClientRect()
      const position = flowInstance
        ? flowInstance.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          })
        : {
            x: event.clientX - (bounds?.left || 0),
            y: event.clientY - (bounds?.top || 0),
          }

      setPaneMenu({
        x: event.clientX - (bounds?.left || 0),
        y: event.clientY - (bounds?.top || 0),
        position,
      })
    },
    [flowInstance]
  )

  function addWorkflowNode(type: WorkflowNodeType) {
    if (!paneMenu) return
    const id = `${type}-${Date.now()}`
    setNodes((currentNodes) => [
      ...currentNodes,
      {
        id,
        type,
        position: paneMenu.position,
        data: {},
      },
    ])
    setPaneMenu(null)
    setStatus('已创建节点，拖动端口可连线')
  }

  return (
    <div className='app-shell flow-shell' data-theme={resolvedTheme}>
      <aside className='canvas-drawer' aria-label='画布列表'>
        <div className='canvas-drawer-header'>
          <div className='section-title'>
            <Layers size={16} />
            <span>画布</span>
          </div>
          <button
            type='button'
            className='icon-button'
            onClick={handleCreateCanvas}
            aria-label='新建画布'
            title='新建画布'
          >
            <Plus size={17} />
          </button>
        </div>

        <div className='canvas-list'>
          {canvases.map((canvas) => (
            <article
              key={canvas.id}
              className={`canvas-item ${canvas.id === activeCanvas?.id ? 'active' : ''}`}
            >
              <div
                className='canvas-switch'
                onClick={() => {
                  setActiveCanvasId(canvas.id)
                  setPaneMenu(null)
                  setStatus(`已切换到 ${canvas.name}`)
                }}
              >
                <label className='canvas-name-field'>
                  <span>画布名称</span>
                  <input
                    value={canvas.name}
                    onChange={(event) => handleRenameCanvas(canvas.id, event.target.value)}
                    onBlur={() => handleCommitCanvasName(canvas.id)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={stopCanvasNameShortcut}
                    aria-label={`修改 ${canvas.name || '画布'} 名称`}
                    placeholder='未命名画布'
                  />
                </label>
                <div className='canvas-switch-meta'>
                  <span>
                  {canvas.nodes.length} 节点 · {canvas.edges.length} 连接
                  </span>
                  {isCanvasGenerating(canvas) ? (
                    <span className='canvas-generation-state'>
                      <Loader2 className='spin' size={12} />
                      生成中
                    </span>
                  ) : null}
                </div>
              </div>
              <div className='canvas-actions'>
                <button
                  type='button'
                  onClick={() => handleDuplicateCanvas(canvas.id)}
                  aria-label={`复制 ${canvas.name}`}
                  title='复制画布'
                >
                  <Copy size={14} />
                </button>
                <button
                  type='button'
                  onClick={() => handleDeleteCanvas(canvas.id)}
                  disabled={canvases.length <= 1}
                  aria-label={`删除 ${canvas.name}`}
                  title='删除画布'
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </aside>

      <main className='workflow-stage'>
        <ReactFlow
          key={activeCanvas?.id}
          nodes={workflowNodes}
          edges={workflowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.45}
          maxZoom={1.35}
          defaultViewport={{ x: 120, y: 80, zoom: 0.76 }}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          elevateEdgesOnSelect
          deleteKeyCode={['Backspace', 'Delete']}
          isValidConnection={isValidConnection}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setFlowInstance}
          onPaneClick={() => setPaneMenu(null)}
          onPaneContextMenu={handlePaneContextMenu}
        >
          <Background color='rgba(255,255,255,0.08)' gap={32} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {paneMenu ? (
          <div
            className='pane-menu'
            style={{ left: paneMenu.x, top: paneMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <strong>创建节点</strong>
            <button type='button' onClick={() => addWorkflowNode('asset')}>
              普通节点 · 参考图片
            </button>
            <button type='button' onClick={() => addWorkflowNode('prompt')}>
              普通节点 · 文字描述
            </button>
            <button type='button' onClick={() => addWorkflowNode('generate')}>
              工作节点 · 图片生成
            </button>
          </div>
        ) : null}

        <header className='floating-header'>
          <div className='brand'>
            <div className='brand-mark'>
              <Sparkles size={21} />
            </div>
            <div>
              <h1>GPT Image Tools</h1>
              <p>右键创建节点 · 拖动端口连线</p>
            </div>
          </div>
          <div className='status-pill'>
            <span>{status}</span>
          </div>
        </header>

        {activeCanvas ? (
          <label className='canvas-title-bar'>
            <Edit3 size={15} />
            <input
              value={activeCanvas.name}
              onChange={(event) => handleRenameCanvas(activeCanvas.id, event.target.value)}
              onBlur={() => handleCommitCanvasName(activeCanvas.id)}
              onKeyDown={stopCanvasNameShortcut}
              aria-label='当前画布名称'
              placeholder='未命名画布'
            />
          </label>
        ) : null}

        {error ? (
          <div className='error-toast'>
            <strong>执行失败</strong>
            <span>{error}</span>
            <button type='button' onClick={() => setError('')} aria-label='关闭错误提示'>
              <X size={15} />
            </button>
          </div>
        ) : null}
      </main>

      <aside className='control-dock'>
        <div className='dock-action-bar'>
          <button className='top-link console-link' onClick={() => void handleOpenConsole()}>
            <Terminal size={16} />
            控制台
            <ExternalLink size={14} />
          </button>
          <button className='top-link shop-link' onClick={() => void handleOpenShop()}>
            <ShoppingBag size={16} />
            小店
            <ExternalLink size={14} />
          </button>
        </div>

        <section className='dock-panel'>
          <div className='section-title'>
            <KeyRound size={16} />
            <span>连接配置</span>
          </div>
          <label className='field'>
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder='https://cc.api-corp.top'
              spellCheck={false}
            />
          </label>

          <div className='connection-config-block'>
            <div className='connection-config-title'>
              <Sparkles size={14} />
              <span>文本模型</span>
              <small>用于优化提示词</small>
            </div>
            <label className='field'>
              <span>文本模型名称</span>
              <input
                value={textModel}
                onChange={(event) => setTextModel(event.target.value)}
                placeholder='gpt-5.5'
                spellCheck={false}
              />
            </label>
            <label className='field'>
              <span>文本模型 API Key</span>
              <input
                value={codexApiKey}
                onChange={(event) => setCodexApiKey(event.target.value)}
                type='password'
                placeholder='sk-...'
                spellCheck={false}
              />
            </label>
          </div>

          <div className='connection-config-block'>
            <div className='connection-config-title'>
              <Sparkles size={14} />
              <span>生图模型</span>
            </div>
            <label className='field'>
              <span>生图模型名称</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {sortedModels.length === 0 ? (
                  <option value={model}>{model}</option>
                ) : (
                  <>
                    {sortedModels.some((item) => item.id === model) ? null : (
                      <option value={model}>{model}</option>
                    )}
                    {sortedModels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </label>
            <label className='field'>
              <span>生图模型 API Key</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                type='password'
                placeholder='sk-...'
                spellCheck={false}
              />
            </label>
          </div>
          <label className='checkbox-row'>
            <input
              type='checkbox'
              checked={persistApiKey}
              onChange={(event) => setPersistApiKey(event.target.checked)}
            />
            <span>将两个 API Key 保存到当前浏览器</span>
          </label>
          <div className='button-grid'>
            <button
              className='secondary login-button'
              onClick={() => {
                setError('')
                setIsLoginDialogOpen(true)
              }}
            >
              <LogIn size={16} />
              登录
            </button>
            <button className='secondary' onClick={handleSaveSettings}>
              <Save size={16} />
              保存设置
            </button>
            <button
              className='secondary'
              onClick={handleFetchModels}
              disabled={isLoadingModels || !baseUrl || !apiKey}
            >
              {isLoadingModels ? (
                <Loader2 className='spin' size={16} />
              ) : (
                <RefreshCw size={16} />
              )}
              获取模型
            </button>
          </div>
        </section>

        <section className='dock-panel compact-panel'>
          <div className='section-title'>
            <Sun size={16} />
            <span>界面</span>
          </div>
          <div className='theme-switcher' aria-label='主题切换'>
            {themeOptions.map((option) => {
              const Icon = option.icon
              return (
                <button
                  key={option.value}
                  type='button'
                  className={themeMode === option.value ? 'active' : ''}
                  onClick={() => void handleThemeChange(option.value)}
                  aria-pressed={themeMode === option.value}
                  title={option.label}
                >
                  <Icon size={15} />
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className='dock-panel compact-panel'>
          <div className='section-title'>
            <Download size={16} />
            <span>本地数据</span>
          </div>
          <div className='button-grid'>
            <button className='secondary' onClick={() => void handleExportBackup()}>
              <Download size={16} />
              导出备份
            </button>
            <label className='secondary file-action'>
              <Upload size={16} />
              导入备份
              <input
                type='file'
                accept='application/json,.json'
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleImportBackup(file)
                  event.currentTarget.value = ''
                }}
              />
            </label>
          </div>
          <button
            className='ghost danger'
            onClick={() => void handleClearImages()}
            disabled={images.length === 0}
          >
            <Trash2 size={16} />
            清空图库
          </button>
          <p>
            图片和设置保存在当前浏览器 IndexedDB。生成任务先提交到服务器后台，结果会短暂缓存在服务器再同步到本地图库；备份文件不包含 API Key。
          </p>
        </section>

        <section className='dock-panel gallery-dock'>
          <div className='gallery-dock-header'>
            <div>
              <h2>本地图库</h2>
              <p>{images.length} 张图片</p>
            </div>
          </div>
          {images.length === 0 ? (
            <div className='gallery-empty'>生成结果会出现在这里</div>
          ) : (
            <GalleryStrip
              images={images}
              onPreview={setPreviewImage}
              onDownload={handleDownloadImage}
              onDelete={(id) => void handleDeleteImage(id)}
            />
          )}
        </section>
      </aside>

      {isLoginDialogOpen ? (
        <div
          className='modal-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='登录中转站'
          onMouseDown={(event) => {
            if (!isNewApiLoggingIn && event.target === event.currentTarget) {
              setIsLoginDialogOpen(false)
            }
          }}
        >
          <form
            className='login-dialog'
            onSubmit={(event) => {
              event.preventDefault()
              void handleNewApiLogin()
            }}
          >
            <div className='dialog-header'>
              <div>
                <strong>登录中转站</strong>
                <span>自动获取生图和提示词优化所需的两个分组秘钥</span>
              </div>
              <button
                type='button'
                className='icon-button'
                onClick={() => setIsLoginDialogOpen(false)}
                disabled={isNewApiLoggingIn}
                aria-label='关闭登录窗口'
              >
                <X size={18} />
              </button>
            </div>

            <label className='field'>
              <span>中转站</span>
              <input value={DEFAULT_BASE_URL} disabled />
            </label>
            <label className='field'>
              <span>账号</span>
              <input
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                autoComplete='username'
                disabled={isNewApiLoggingIn}
                placeholder='用户名或邮箱'
              />
            </label>
            <label className='field'>
              <span>密码</span>
              <input
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                type='password'
                autoComplete='current-password'
                disabled={isNewApiLoggingIn}
                placeholder='中转站密码'
              />
            </label>
            <p>
              账号密码只用于本次登录中转站；服务端不保存。成功后仅把生图和 Codex API Key 保存到当前浏览器。
            </p>
            <div className='dialog-actions'>
              <button
                type='button'
                className='ghost'
                onClick={() => setIsLoginDialogOpen(false)}
                disabled={isNewApiLoggingIn}
              >
                取消
              </button>
              <button
                type='submit'
                className='secondary'
                disabled={isNewApiLoggingIn || !loginUsername.trim() || !loginPassword}
              >
                {isNewApiLoggingIn ? <Loader2 className='spin' size={16} /> : <LogIn size={16} />}
                登录并获取秘钥
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {previewImage ? (
        <div
          className='modal-overlay preview-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='图片预览'
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewImage(null)
          }}
        >
          <div className='preview-dialog'>
            <div className='preview-header'>
              <div>
                <strong>{previewImage.model}</strong>
                <span>
                  {previewImage.size} · {previewImage.quality} ·{' '}
                  {new Date(previewImage.createdAt).toLocaleString()}
                </span>
              </div>
              <button
                className='icon-button'
                onClick={() => setPreviewImage(null)}
                aria-label='关闭预览'
              >
                <X size={18} />
              </button>
            </div>
            <div className='preview-frame'>
              <img
                src={previewImage.src}
                alt={previewImage.revisedPrompt || previewImage.prompt}
              />
            </div>
            <p>{previewImage.revisedPrompt || previewImage.prompt}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
