import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
  Check,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Github,
  Home,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LogIn,
  Loader2,
  Menu,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Save,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react'
import {
  clearImages,
  deleteImage,
  exportBackup,
  getSettings,
  importBackup,
  listImages,
  listReferenceImageBlobs,
  saveSettings,
  saveImages,
  saveReferenceImageBlobs,
} from './storage'
import { bridge } from './bridge'
import { commerceCategoryTree } from './commerceCategories'
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
  StyleCategory,
  StyleOption,
  ThemeMode,
} from './types'

const DEFAULT_BASE_URL = 'https://hotapi.top'
const DEFAULT_TEXT_BASE_URL = DEFAULT_BASE_URL
const DEFAULT_IMAGE_BASE_URL = DEFAULT_BASE_URL
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_TEXT_MODEL = 'gpt-5.5'
const DEFAULT_IMAGE_RETRY_COUNT = 0
const DEFAULT_PROMPT_OPTIMIZATION_PRESET: PromptOptimizationPreset = 'ecommerce'
const CONSOLE_URL = 'https://hotapi.top/'
const GITHUB_REPO_URL = 'https://github.com/1093791954/image-tool'
const MAX_COMMERCE_PRODUCT_IMAGES = 4
const COMMERCE_REFERENCE_MAX_SIDE = 1600
const COMMERCE_REFERENCE_JPEG_QUALITY = 0.86
const COMMERCE_PRODUCT_SHEET_SIZE = 1600
const ADVANCED_SKETCH_WIDTH = 960
const ADVANCED_SKETCH_HEIGHT = 540
const CONFIGURATION_NOTICE_MESSAGE =
  '请先在控制台补全生图 API Key 和模型，配置完成后再继续使用其他页面。'

function normalizeImageRetryCount(value: unknown) {
  const count = Math.floor(Number(value))
  if (!Number.isFinite(count)) return DEFAULT_IMAGE_RETRY_COUNT
  return Math.max(0, Math.min(5, count))
}

const CUSTOM_SIZE_VALUE = 'custom'
const sizeOptions = [
  { ratio: '1:1', value: '1024x1024', label: '方图' },
  { ratio: '3:4', value: '1024x1365', label: '竖版海报' },
  { ratio: '4:3', value: '1365x1024', label: '横版构图' },
  { ratio: '16:9', value: '1536x864', label: '宽屏封面' },
  { ratio: '9:16', value: '864x1536', label: '手机竖屏' },
  { ratio: '2:3', value: '1024x1536', label: '竖版生成' },
  { ratio: '3:2', value: '1536x1024', label: '横版生成' },
  { ratio: '4:5', value: '1024x1280', label: '社媒竖图' },
  { ratio: '5:4', value: '1280x1024', label: '产品横图' },
  { ratio: '4:7', value: '1024x1792', label: '长竖图' },
  { ratio: '7:4', value: '1792x1024', label: '超宽图' },
]
const sizes = sizeOptions.map((item) => item.value)
const qualities = ['auto', 'standard', 'hd', 'low', 'medium', 'high']
const counts = [1, 2, 3, 4]
const inputFidelities = ['low', 'high'] as const
const backgroundOptions: Array<{ value: AdvancedBackground; label: string }> = [
  { value: 'auto', label: 'auto' },
  { value: 'opaque', label: 'opaque' },
  { value: 'transparent', label: 'transparent' },
]
const creativityOptions: Array<{ value: AdvancedCreativity; label: string }> = [
  { value: 'strict', label: '严格' },
  { value: 'balanced', label: '平衡' },
  { value: 'exploratory', label: '发散' },
]
const styleWeightOptions: Array<{ value: AdvancedStyleWeight; label: string }> = [
  { value: 'weak', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'strong', label: '强' },
]
const sketchWeightOptions: Array<{ value: AdvancedSketchWeight; label: string }> = [
  { value: 'reference', label: '参考' },
  { value: 'strict', label: '严格遵循' },
  { value: 'layout', label: '只看布局' },
]
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

function parseSizeValue(value: string) {
  const match = value.trim().match(/^(\d{2,5})x(\d{2,5})$/)
  if (!match) return null
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  }
}

function sizeOptionLabel(option: (typeof sizeOptions)[number]) {
  return `${option.ratio} · ${option.value} · ${option.label}`
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : greatestCommonDivisor(b, a % b)
}

function ratioLabelForSize(value: string) {
  const parsed = parseSizeValue(value)
  if (!parsed || !parsed.width || !parsed.height) return ''

  const divisor = greatestCommonDivisor(parsed.width, parsed.height)
  if (!divisor) return ''
  return `${parsed.width / divisor}:${parsed.height / divisor}`
}

function workflowSizeOptionLabel(value: string) {
  const preset = sizeOptions.find((option) => option.value === value)
  const ratio = preset?.ratio || ratioLabelForSize(value)
  return ratio ? `${ratio} · ${value}` : value
}

function buildCommerceMainPrompt(description: string, categoryPath = '') {
  const trimmedDescription = description.trim() || '用户未填写额外文字描述。'
  const trimmedCategoryPath = categoryPath.trim() || '用户未选择商品品类。'
  return [
    '你是一名资深电商视觉设计师，请基于参考图生成一张电商商品主图。',
    `商品品类：${trimmedCategoryPath}。该品类是强约束，如果图像识别结果和用户选择的品类冲突，优先按用户选择的品类理解商品。`,
    '参考图中的商品白底图是商品主体依据，必须保持商品外观、结构、颜色、材质和关键细节真实一致，不要改变商品本身。',
    '目标风格图只用于迁移构图节奏、光线氛围、背景质感、色彩倾向和视觉高级感，不要复制风格图中的商品或品牌元素。',
    '根据目标风格图完成商品替换；如果风格图中有文字，只在用户描述提供明确文案时选择性替换，否则去除或弱化原图文字。',
    `商品信息和主图诉求：${trimmedDescription}`,
    '画面要求：主体清晰醒目，构图稳定，适合电商列表首图；背景干净但有质感，光影自然，边缘干净，产品比例合理。',
    '不要生成无关文字、水印、Logo、价格、二维码或平台界面元素。输出应像真实商业摄影和精修后的电商主图。',
  ].join('\n')
}

function buildCommerceDetailPrompt(description: string, categoryPath = '') {
  const trimmedDescription = description.trim() || '用户未填写额外文字描述。'
  const trimmedCategoryPath = categoryPath.trim() || '用户未选择商品品类。'
  return [
    '你是一名资深电商详情页视觉设计师，请基于参考图生成一张商品详情图。',
    `商品品类：${trimmedCategoryPath}。该品类是强约束，如果图像识别结果和用户选择的品类冲突，优先按用户选择的品类理解商品。`,
    '参考图中的商品白底图是商品主体依据，必须保持商品外观、结构、包装、颜色、材质和关键细节真实一致，不要改变商品本身。',
    '目标详情风格图只用于迁移详情页版式、分区节奏、背景质感、光线氛围、色彩倾向、道具关系和文字排版，不要复制风格图中的商品或品牌元素。',
    '画面应像电商详情页中的一屏核心卖点图：有清晰主视觉、短卖点文案、局部细节或场景辅助展示，层级清楚，适合用户继续向下浏览。',
    `商品信息和详情图诉求：${trimmedDescription}`,
    '文字只使用用户明确提供的短句，按目标风格图的文字区域选择性排版；没有足够文案时减少文字，不要编造品牌、功效、认证、价格、二维码或平台界面元素。',
    '输出应像真实商业精修后的电商详情图，干净、高级、信息明确，避免长段文字、低清、错字、水印和无关 Logo。',
  ].join('\n')
}

function buildCommerceEditPrompt(prompt: string, productImageCount: number, kind: 'main' | 'detail') {
  if (productImageCount <= 1) return prompt
  const styleLabel = kind === 'detail' ? '目标详情风格图' : '目标风格图'
  return [
    '【参考图输入说明】',
    `第一张参考图是同一商品的 ${productImageCount} 个白底角度合成参考板，用于理解商品真实外观、结构、包装文字、材质和细节。`,
    `第二张参考图是${styleLabel}，用于迁移构图、背景、光影、色彩、版式层级和画面氛围。`,
    '生成时不要保留参考板的拼图排版、边框或分隔线，只提取商品主体并替换到目标风格图对应位置。',
    '',
    prompt,
  ].join('\n')
}

type WorkflowNode = Node<
  Record<string, unknown>,
  WorkflowNodeType
>

type WorkflowNodeType = 'asset' | 'prompt' | 'style' | 'generate'
type WorkflowEdge = Edge<Partial<BlueprintEdgeData>, 'blueprint'>

type PaneMenu = {
  x: number
  y: number
  position: { x: number; y: number }
} | null

type AppView = 'home' | 'advanced' | 'commerce' | 'console' | 'gallery' | 'workflow'
type AdvancedBackground = 'auto' | 'opaque' | 'transparent'
type AdvancedCreativity = 'strict' | 'balanced' | 'exploratory'
type AdvancedStyleWeight = 'weak' | 'medium' | 'strong'
type AdvancedSketchWeight = 'reference' | 'strict' | 'layout'

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

type StateUpdater<T> = T | ((current: T) => T)

const WORKFLOW_CANVASES_STORAGE_KEY = 'gpt-image-tools.workflow-canvases.v1'
const ACTIVE_CANVAS_STORAGE_KEY = 'gpt-image-tools.active-canvas.v1'
const CANVAS_DRAWER_AUTO_OPEN_QUERY = '(min-width: 1120px)'

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
  return Array.isArray(value) ? ensureReferenceTitles(value as ReferenceImage[]).slice(0, 1) : []
}

function normalizeAssetNodeReferenceImages(images: ReferenceImage[]) {
  return ensureReferenceTitles(images).slice(0, 1)
}

function getWorkflowNodeSelectedStyleId(node?: Pick<WorkflowNode, 'data'> | null) {
  const value = node?.data?.selectedStyleId
  return typeof value === 'string' ? value : ''
}

function getWorkflowNodePrompt(node?: Pick<WorkflowNode, 'data'> | null) {
  const value = node?.data?.prompt
  return typeof value === 'string' ? value : ''
}

function getWorkflowNodePromptOptimizationPreset(node?: Pick<WorkflowNode, 'data'> | null) {
  return normalizePromptOptimizationPreset(node?.data?.promptOptimizationPreset)
}

function getWorkflowNodeLatestImageId(node?: Pick<WorkflowNode, 'data'> | null) {
  const value = node?.data?.latestImageId
  return typeof value === 'string' ? value : ''
}

function getWorkflowNodeCustomOutputTitle(node?: Pick<WorkflowNode, 'data'> | null) {
  const value = node?.data?.outputTitle
  return typeof value === 'string' ? normalizeReferenceTitle(value) : ''
}

function defaultGenerateOutputTitle(nodeId: string) {
  return normalizeReferenceTitle(`生成图-${nodeId}`) || '生成图'
}

function getWorkflowNodeOutputTitle(node: Pick<WorkflowNode, 'id' | 'data'>) {
  return getWorkflowNodeCustomOutputTitle(node) || defaultGenerateOutputTitle(node.id)
}

function workflowNodeDataForStorage(node: WorkflowNode) {
  if (node.type === 'asset') {
    const referenceImages = getWorkflowNodeReferenceImages(node).map(stripReferenceImageDataUrl)
    return referenceImages.length > 0 ? { referenceImages } : {}
  }
  if (node.type === 'style') {
    const selectedStyleId = getWorkflowNodeSelectedStyleId(node)
    return selectedStyleId ? { selectedStyleId } : {}
  }
  if (node.type === 'prompt') {
    const prompt = getWorkflowNodePrompt(node)
    const promptOptimizationPreset = getWorkflowNodePromptOptimizationPreset(node)
    return {
      ...(prompt ? { prompt } : {}),
      ...(promptOptimizationPreset !== DEFAULT_PROMPT_OPTIMIZATION_PRESET
        ? { promptOptimizationPreset }
        : {}),
    }
  }
  if (node.type === 'generate') {
    const latestImageId = getWorkflowNodeLatestImageId(node)
    const outputTitle = getWorkflowNodeCustomOutputTitle(node)
    return {
      ...(latestImageId ? { latestImageId } : {}),
      ...(outputTitle ? { outputTitle } : {}),
    }
  }
  return {}
}

function stripReferenceImageDataUrl(image: ReferenceImage): Omit<ReferenceImage, 'dataUrl'> {
  const { dataUrl: _dataUrl, ...rest } = image
  return rest
}

function serializeWorkflowCanvases(canvases: WorkflowCanvas[]) {
  return canvases.map((canvas) => ({
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      return {
        ...node,
        data: workflowNodeDataForStorage(node),
      }
    }),
  }))
}

function extractReferenceImageBlobs(canvases: WorkflowCanvas[]) {
  const records: Array<{ id: string; dataUrl: string }> = []

  canvases.forEach((canvas) => {
    canvas.nodes.forEach((node) => {
      if (node.type !== 'asset') return
      getWorkflowNodeReferenceImages(node).forEach((image) => {
        if (!image.dataUrl) return
        records.push({ id: image.id, dataUrl: image.dataUrl })
      })
    })
  })

  return records
}

function hydrateWorkflowCanvases(
  canvases: WorkflowCanvas[],
  blobs: Array<{ id: string; dataUrl: string }>
) {
  if (blobs.length === 0) return canvases

  const blobById = new Map(blobs.map((blob) => [blob.id, blob.dataUrl]))

  return canvases.map((canvas) => ({
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.type !== 'asset') return node

      const referenceImages = getWorkflowNodeReferenceImages(node).map((image) => ({
        ...image,
        dataUrl: image.dataUrl || blobById.get(image.id) || '',
      }))

      return {
        ...node,
        data: referenceImages.length > 0 ? { referenceImages } : {},
      }
    }),
  }))
}

function cloneWorkflowNodes(
  nodes: WorkflowNode[],
  legacyReferenceImages: ReferenceImage[] = [],
  legacyPrompt = '',
  legacyPromptOptimizationPreset: PromptOptimizationPreset = DEFAULT_PROMPT_OPTIMIZATION_PRESET
) {
  const normalizedLegacyReferenceImages = ensureReferenceTitles(legacyReferenceImages)
  let hasStoredAssetReferences = false
  let hasStoredPrompt = false
  let hasStoredPromptOptimizationPreset = false
  let firstPromptIndex = -1

  const clonedNodes = nodes.map((node, index) => {
    let data: Record<string, unknown> = {}

    if (node.type === 'asset') {
      const referenceImages = normalizeAssetNodeReferenceImages(getWorkflowNodeReferenceImages(node))
      if (referenceImages.length > 0) {
        hasStoredAssetReferences = true
        data = { referenceImages }
      }
    } else if (node.type === 'style') {
      const selectedStyleId = getWorkflowNodeSelectedStyleId(node)
      data = selectedStyleId ? { selectedStyleId } : {}
    } else if (node.type === 'prompt') {
      if (firstPromptIndex < 0) firstPromptIndex = index
      const prompt = getWorkflowNodePrompt(node)
      const promptOptimizationPreset = getWorkflowNodePromptOptimizationPreset(node)
      if (prompt) hasStoredPrompt = true
      if (promptOptimizationPreset !== DEFAULT_PROMPT_OPTIMIZATION_PRESET) {
        hasStoredPromptOptimizationPreset = true
      }
      data = {
        ...(prompt ? { prompt } : {}),
        ...(promptOptimizationPreset !== DEFAULT_PROMPT_OPTIMIZATION_PRESET
          ? { promptOptimizationPreset }
          : {}),
      }
    } else if (node.type === 'generate') {
      const latestImageId = getWorkflowNodeLatestImageId(node)
      const outputTitle = getWorkflowNodeCustomOutputTitle(node)
      data = {
        ...(latestImageId ? { latestImageId } : {}),
        ...(outputTitle ? { outputTitle } : {}),
      }
    }

    return {
      ...node,
      position: { ...node.position },
      data,
    }
  })

  if (
    firstPromptIndex >= 0 &&
    (legacyPrompt || legacyPromptOptimizationPreset !== DEFAULT_PROMPT_OPTIMIZATION_PRESET)
  ) {
    clonedNodes[firstPromptIndex] = {
      ...clonedNodes[firstPromptIndex],
      data: {
        ...clonedNodes[firstPromptIndex].data,
        ...(!hasStoredPrompt && legacyPrompt ? { prompt: legacyPrompt } : {}),
        ...(!hasStoredPromptOptimizationPreset &&
        legacyPromptOptimizationPreset !== DEFAULT_PROMPT_OPTIMIZATION_PRESET
          ? { promptOptimizationPreset: legacyPromptOptimizationPreset }
          : {}),
      },
    }
  }

  if (normalizedLegacyReferenceImages.length > 0 && !hasStoredAssetReferences) {
    const assetIndices = clonedNodes
      .map((node, index) => (node.type === 'asset' ? index : -1))
      .filter((index) => index >= 0)

    assetIndices.forEach((assetIndex, index) => {
      const image = normalizedLegacyReferenceImages[index]
      if (!image) return

      clonedNodes[assetIndex] = {
        ...clonedNodes[assetIndex],
        data: { referenceImages: [image] },
      }
    })
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

function referenceTitleKey(title: string) {
  return normalizeReferenceTitle(title).toLocaleLowerCase()
}

function referenceImageOwnerId(imageId: string) {
  return `asset:${imageId}`
}

function generateOutputOwnerId(nodeId: string) {
  return `generate:${nodeId}`
}

function createUniqueReferenceTitle(baseTitle: string, entries: Array<{ title: string }>) {
  const normalizedBase = normalizeReferenceTitle(baseTitle) || '图片'
  const usedKeys = new Set(entries.map((entry) => referenceTitleKey(entry.title)).filter(Boolean))
  if (!usedKeys.has(referenceTitleKey(normalizedBase))) return normalizedBase

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`
    const candidate = `${normalizedBase.slice(0, Math.max(1, 24 - suffix.length))}${suffix}`
    if (candidate && !usedKeys.has(referenceTitleKey(candidate))) return candidate
  }

  const suffix = `-${Date.now()}`
  return `${normalizedBase.slice(0, Math.max(1, 24 - suffix.length))}${suffix}`
}

function getCanvasReferenceNameEntries(canvas?: Pick<WorkflowCanvas, 'nodes'> | null) {
  if (!canvas) return []

  const entries: Array<{
    ownerId: string
    nodeId: string
    kind: 'asset' | 'generate'
    title: string
  }> = []

  canvas.nodes.forEach((node) => {
    if (node.type === 'asset') {
      getWorkflowNodeReferenceImages(node).forEach((image) => {
        const title = normalizeReferenceTitle(image.title || image.name)
        if (!title) return
        entries.push({
          ownerId: referenceImageOwnerId(image.id),
          nodeId: node.id,
          kind: 'asset',
          title,
        })
      })
      return
    }

    if (node.type === 'generate') {
      entries.push({
        ownerId: generateOutputOwnerId(node.id),
        nodeId: node.id,
        kind: 'generate',
        title: getWorkflowNodeOutputTitle(node),
      })
    }
  })

  return entries
}

function isReferenceTitleTaken(
  canvas: Pick<WorkflowCanvas, 'nodes'> | null | undefined,
  title: string,
  ownerId: string
) {
  const key = referenceTitleKey(title)
  if (!key) return false
  return getCanvasReferenceNameEntries(canvas).some(
    (entry) => entry.ownerId !== ownerId && referenceTitleKey(entry.title) === key
  )
}

function getDuplicateCanvasReferenceTitles(canvas?: Pick<WorkflowCanvas, 'nodes'> | null) {
  const seen = new Map<string, string>()
  const duplicates = new Set<string>()

  getCanvasReferenceNameEntries(canvas).forEach((entry) => {
    const key = referenceTitleKey(entry.title)
    if (!key) return
    const existing = seen.get(key)
    if (existing) duplicates.add(existing)
    else seen.set(key, entry.title)
  })

  return [...duplicates]
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

function getPromptAssetReferenceImages(
  promptNodeId: string,
  canvas: Pick<WorkflowCanvas, 'nodes' | 'edges'> | null | undefined
) {
  if (!canvas) return []

  const connectedAssetNodeIds = new Set(
    canvas.edges
      .filter(
        (edge) =>
          edge.target === promptNodeId &&
          edge.sourceHandle === 'reference' &&
          (edge.targetHandle === 'reference' || edge.targetHandle?.startsWith('reference-')) &&
          canvas.nodes.find((node) => node.id === edge.source)?.type === 'asset'
      )
      .map((edge) => edge.source)
  )

  const seen = new Set<string>()
  const images: ReferenceImage[] = []
  canvas.nodes.forEach((node) => {
    if (node.type !== 'asset' || !connectedAssetNodeIds.has(node.id)) return
    getWorkflowNodeReferenceImages(node).forEach((image) => {
      if (seen.has(image.id)) return
      seen.add(image.id)
      images.push(image)
    })
  })

  return images
}

function getPromptGeneratedReferenceImages(
  promptNodeId: string,
  canvas: Pick<WorkflowCanvas, 'nodes' | 'edges'> | null | undefined,
  images: LocalImageRecord[]
) {
  if (!canvas) return []

  const connectedGenerateNodeIds = new Set(
    canvas.edges
      .filter(
        (edge) =>
          edge.target === promptNodeId &&
          edge.sourceHandle === 'generated-image' &&
          (edge.targetHandle === 'reference' || edge.targetHandle?.startsWith('reference-')) &&
          canvas.nodes.find((node) => node.id === edge.source)?.type === 'generate'
      )
      .map((edge) => edge.source)
  )

  return canvas.nodes
    .filter((node) => node.type === 'generate' && connectedGenerateNodeIds.has(node.id))
    .map((node) => {
      const title = getWorkflowNodeOutputTitle(node)
      const latestImage = images.find((image) => image.id === getWorkflowNodeLatestImageId(node))
      return {
        id: `generated-${node.id}`,
        name: `${title}.png`,
        title,
        type: 'image/png',
        dataUrl: latestImage?.src || '',
      }
    })
}

function getPromptMentionReferenceImages(
  promptNodeId: string,
  canvas: Pick<WorkflowCanvas, 'nodes' | 'edges'> | null | undefined,
  images: LocalImageRecord[]
) {
  return [
    ...getPromptAssetReferenceImages(promptNodeId, canvas),
    ...getPromptGeneratedReferenceImages(promptNodeId, canvas, images),
  ]
}

function getCanvasSelectedStyleIds(canvas?: Pick<WorkflowCanvas, 'nodes' | 'edges'> | null) {
  if (!canvas) return []
  const styleNodeIds = new Set(
    canvas.nodes.filter((node) => node.type === 'style').map((node) => node.id)
  )
  const connectedStyleNodeIds = new Set(
    canvas.edges
      .filter(
        (edge) =>
          edge.sourceHandle === 'style' &&
          edge.targetHandle === 'style' &&
          styleNodeIds.has(edge.source)
      )
      .map((edge) => edge.source)
  )
  const scopedNodeIds = connectedStyleNodeIds.size > 0 ? connectedStyleNodeIds : styleNodeIds
  const selectedIds: string[] = []
  canvas.nodes.forEach((node) => {
    if (node.type !== 'style' || !scopedNodeIds.has(node.id)) return
    const selectedStyleId = getWorkflowNodeSelectedStyleId(node)
    if (selectedStyleId && !selectedIds.includes(selectedStyleId)) selectedIds.push(selectedStyleId)
  })
  return selectedIds
}

function getPromptSelectedStyleIds(
  promptNodeId: string,
  canvas?: Pick<WorkflowCanvas, 'nodes' | 'edges'> | null
) {
  if (!canvas) return []
  const connectedStyleNodeIds = new Set(
    canvas.edges
      .filter(
        (edge) =>
          edge.target === promptNodeId &&
          edge.sourceHandle === 'style' &&
          edge.targetHandle === 'style'
      )
      .map((edge) => edge.source)
  )
  if (connectedStyleNodeIds.size === 0) return getCanvasSelectedStyleIds(canvas)

  const selectedIds: string[] = []
  canvas.nodes.forEach((node) => {
    if (node.type !== 'style' || !connectedStyleNodeIds.has(node.id)) return
    const selectedStyleId = getWorkflowNodeSelectedStyleId(node)
    if (selectedStyleId && !selectedIds.includes(selectedStyleId)) selectedIds.push(selectedStyleId)
  })
  return selectedIds
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
    base?.referenceImages || [],
    base?.prompt || '',
    base?.promptOptimizationPreset || DEFAULT_PROMPT_OPTIMIZATION_PRESET
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
      ? cloneWorkflowNodes(
          canvas.nodes as WorkflowNode[],
          legacyReferenceImages,
          typeof canvas.prompt === 'string' ? canvas.prompt : '',
          normalizePromptOptimizationPreset(canvas.promptOptimizationPreset)
        )
      : cloneWorkflowNodes(
          initialWorkflowNodes,
          legacyReferenceImages,
          typeof canvas.prompt === 'string' ? canvas.prompt : '',
          normalizePromptOptimizationPreset(canvas.promptOptimizationPreset)
        )
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
      generationTaskId: undefined,
      generationTaskStatus: undefined,
      generationTaskUpdatedAt: undefined,
    })
  })

  return canvases
}

function loadWorkflowCanvases() {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_CANVASES_STORAGE_KEY)
    const stored = raw ? normalizeStoredCanvases(JSON.parse(raw)) : []
    return stored.length > 0 ? stored : [createWorkflowCanvas(1)]
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

function protectPromptMentionsForOptimization(prompt: string, images: ReferenceImage[]) {
  const mentions = extractReferenceMentions(
    prompt,
    images.map((image) => image.title || image.name)
  ).map((title) => `@${title}`)

  return {
    mentions,
    prompt: mentions.length
      ? `${prompt}\n\n【引用保护】\n以下 @引用 是工作流图片引用锚点，必须在优化后逐字保留，不能删除、改名、翻译、拆分或替换：${mentions.join('、')}`
      : prompt,
  }
}

function normalizeOptimizedPromptMentions(
  prompt: string,
  images: ReferenceImage[],
  protectedMentions: string[] = []
) {
  const orderedMentions = [
    ...new Set([
      ...protectedMentions.map((mention) => `@${normalizeReferenceTitle(mention)}`).filter((mention) => mention !== '@'),
      ...images
        .map((image) => normalizeReferenceTitle(image.title || image.name))
        .filter(Boolean)
        .map((title) => `@${title}`),
    ]),
  ].sort((a, b) => b.length - a.length)
  if (orderedMentions.length === 0) return prompt.trim()

  let next = prompt
  orderedMentions.forEach((mention) => {
    const pattern = new RegExp(escapeRegExp(mention), 'g')
    next = next.replace(pattern, ` ${mention} `)
  })

  const missingMentions = protectedMentions.filter((mention) => {
    const normalizedMention = `@${normalizeReferenceTitle(mention)}`
    return normalizedMention !== '@' && !new RegExp(escapeRegExp(normalizedMention)).test(next)
  })
  if (missingMentions.length > 0) {
    next = `${missingMentions.join(' ')} ${next}`
  }

  return next
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’])/g, '$1')
    .replace(/([，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’])\s+/g, '$1 ')
    .trim()
}

function blobFromDataUrl(src: string) {
  const match = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/)
  if (!match) return null

  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: mimeType })
}

function downloadDataUrl(src: string, filename: string) {
  const link = document.createElement('a')
  const blob = blobFromDataUrl(src)
  const url = blob ? URL.createObjectURL(blob) : src

  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()

  if (blob) {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
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

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function imageSourceToDataUrl(src: string) {
  if (src.startsWith('data:')) return src

  try {
    const response = await fetch(src)
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`)
    return blobToDataUrl(await response.blob())
  } catch (error) {
    throw new Error(
      `无法读取图库图片。浏览器不能跨域下载该图片 URL，请优先使用 b64_json 响应格式。${error instanceof Error ? ` 原因：${error.message}` : ''}`
    )
  }
}

function mimeTypeFromDataUrl(dataUrl: string) {
  return dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png'
}

function imageExtensionFromMimeType(type: string) {
  if (type === 'image/jpeg') return 'jpg'
  return type.split('/')[1]?.replace(/[^\w.+-]/g, '') || 'png'
}

function loadLocalImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = url
  })
}

async function fileToCommerceReferenceDataUrl(file: File) {
  if (!file.type.startsWith('image/')) return fileToDataUrl(file)

  const url = URL.createObjectURL(file)
  try {
    const image = await loadLocalImage(url)
    const maxSide = Math.max(image.naturalWidth, image.naturalHeight)
    const scale = maxSide > COMMERCE_REFERENCE_MAX_SIDE ? COMMERCE_REFERENCE_MAX_SIDE / maxSide : 1
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return fileToDataUrl(file)

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', COMMERCE_REFERENCE_JPEG_QUALITY)
  } catch {
    return fileToDataUrl(file)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawImageContained(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const imageRatio = image.naturalWidth / image.naturalHeight
  const frameRatio = width / height
  const drawWidth = imageRatio > frameRatio ? width : height * imageRatio
  const drawHeight = imageRatio > frameRatio ? width / imageRatio : height
  const drawX = x + (width - drawWidth) / 2
  const drawY = y + (height - drawHeight) / 2
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight)
}

async function buildCommerceProductReferenceImage(images: ReferenceImage[]) {
  if (images.length <= 1) return images[0]

  const loadedImages = await Promise.all(images.map((image) => loadLocalImage(image.dataUrl)))
  const canvas = document.createElement('canvas')
  canvas.width = COMMERCE_PRODUCT_SHEET_SIZE
  canvas.height = COMMERCE_PRODUCT_SHEET_SIZE

  const context = canvas.getContext('2d')
  if (!context) return images[0]

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const columns = images.length <= 2 ? images.length : 2
  const rows = Math.ceil(images.length / columns)
  const padding = 44
  const gap = 28
  const labelHeight = 48
  const cellWidth = (canvas.width - padding * 2 - gap * (columns - 1)) / columns
  const cellHeight = (canvas.height - padding * 2 - gap * (rows - 1)) / rows

  context.font = '26px Arial, sans-serif'
  context.textAlign = 'left'
  context.textBaseline = 'middle'

  loadedImages.forEach((image, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = padding + column * (cellWidth + gap)
    const y = padding + row * (cellHeight + gap)

    context.fillStyle = '#f7f8fb'
    context.fillRect(x, y, cellWidth, cellHeight)
    context.strokeStyle = '#d7dbe5'
    context.lineWidth = 2
    context.strokeRect(x, y, cellWidth, cellHeight)

    context.fillStyle = '#3d4557'
    context.fillText(`product angle ${index + 1}`, x + 18, y + labelHeight / 2)
    drawImageContained(context, image, x + 18, y + labelHeight, cellWidth - 36, cellHeight - labelHeight - 18)
  })

  return {
    id: createLocalId('commerce-product-sheet'),
    name: 'commerce-product-reference-sheet.jpg',
    title: `商品多角度参考图（${images.length} 张）`,
    type: 'image/jpeg',
    dataUrl: canvas.toDataURL('image/jpeg', COMMERCE_REFERENCE_JPEG_QUALITY),
  }
}

function taskStatusLabel(status: ImageGenerationTask['status']) {
  if (status === 'queued') return '生图请求已排队'
  if (status === 'running') return '正在请求上游生成图片...'
  if (status === 'completed') return '上游已返回结果，正在保存到本地'
  if (status === 'expired') return '生图请求已过期'
  return '上游生图失败'
}

function promptWithStyles(
  prompt: string,
  selectedStyles: StyleOption[],
  styleWeight: AdvancedStyleWeight = 'medium'
) {
  if (selectedStyles.length === 0) return prompt
  const weightInstructions: Record<AdvancedStyleWeight, string> = {
    weak: '风格权重：弱。只提取轻量的色彩、光线和质感倾向，优先保留用户原始画面意图。',
    medium: '风格权重：中。平衡迁移风格协议中的构图节奏、光线氛围、背景质感和色彩倾向。',
    strong:
      '风格权重：强。显著应用风格协议的视觉语言、光影、质感和色彩系统，但不要改变用户要求的主体身份和核心内容。',
  }
  const styleProtocols = selectedStyles
    .map(
      (style, index) =>
        `风格 ${index + 1}：${style.category} / ${style.name}\n${JSON.stringify(style.styleJson, null, 2)}`
    )
    .join('\n\n')
  return `${prompt}\n\n请按以下风格协议生成图像。风格协议只用于控制视觉效果，不要在画面中渲染 JSON 或参数文字；如果有参考图，请保持参考图主体内容不变，只应用风格转换。\n${weightInstructions[styleWeight]}\n${styleProtocols}`
}

function promptWithNegativePrompt(prompt: string, negativePrompt: string) {
  const value = negativePrompt.trim()
  if (!value) return prompt
  return `${prompt}\n\n【负面提示词】\n避免出现：${value}。`
}

function promptWithBackground(prompt: string, background: AdvancedBackground) {
  const instructions: Record<AdvancedBackground, string> = {
    auto: '背景策略：auto。根据主体和用途自动选择最合适的背景复杂度，背景服务主体，不抢画面重心。',
    opaque: '背景策略：opaque。生成不透明背景，背景干净完整，有真实光影和空间关系。',
    transparent: '背景策略：transparent。生成透明背景或适合抠图的干净主体边缘，不要添加不必要的实景背景。',
  }
  return `${prompt}\n\n【背景】\n${instructions[background]}`
}

function promptWithCreativity(prompt: string, creativity: AdvancedCreativity) {
  const instructions: Record<AdvancedCreativity, string> = {
    strict: '创意强度：严格。严格遵循用户描述，不自行添加新主体、新道具或复杂背景。',
    balanced: '创意强度：平衡。在保留用户核心意图的基础上，适度优化构图、光线、质感和完成度。',
    exploratory:
      '创意强度：发散。围绕用户主题做更有表现力的视觉演绎，可增强场景、光影和风格，但不要偏离主体诉求。',
  }
  return `${prompt}\n\n【创意强度】\n${instructions[creativity]}`
}

export function App() {
  const [currentView, setCurrentView] = useState<AppView>('home')
  const [textBaseUrl, setTextBaseUrl] = useState(DEFAULT_TEXT_BASE_URL)
  const [imageBaseUrl, setImageBaseUrl] = useState(DEFAULT_IMAGE_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [codexApiKey, setCodexApiKey] = useState('')
  const [imageRetryCount, setImageRetryCount] = useState(DEFAULT_IMAGE_RETRY_COUNT)
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false)
  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false)
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [isNewApiLoggingIn, setIsNewApiLoggingIn] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark')
  const [models, setModels] = useState<ModelOption[]>([])
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [styleSummaries, setStyleSummaries] = useState<StyleOption[]>([])
  const [styleCategories, setStyleCategories] = useState<StyleCategory[]>([])
  const [isLoadingStyles, setIsLoadingStyles] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL)
  const [size, setSize] = useState('1024x1024')
  const [sizeMode, setSizeMode] = useState<'preset' | 'custom'>('preset')
  const [customSizeWidth, setCustomSizeWidth] = useState('1024')
  const [customSizeHeight, setCustomSizeHeight] = useState('1024')
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>('url')
  const [inputFidelity, setInputFidelity] = useState<'low' | 'high'>('high')
  const [advancedModel, setAdvancedModel] = useState(DEFAULT_MODEL)
  const [advancedSize, setAdvancedSize] = useState('1024x1024')
  const [advancedSizeMode, setAdvancedSizeMode] = useState<'preset' | 'custom'>('preset')
  const [advancedCustomSizeWidth, setAdvancedCustomSizeWidth] = useState('1024')
  const [advancedCustomSizeHeight, setAdvancedCustomSizeHeight] = useState('1024')
  const [advancedQuality, setAdvancedQuality] = useState('auto')
  const [advancedCount, setAdvancedCount] = useState(1)
  const [advancedResponseFormat, setAdvancedResponseFormat] =
    useState<'url' | 'b64_json'>('url')
  const [advancedInputFidelity, setAdvancedInputFidelity] = useState<'low' | 'high'>('high')
  const [advancedNegativePrompt, setAdvancedNegativePrompt] = useState('')
  const [advancedBackground, setAdvancedBackground] = useState<AdvancedBackground>('auto')
  const [advancedCreativity, setAdvancedCreativity] = useState<AdvancedCreativity>('balanced')
  const [advancedStyleWeight, setAdvancedStyleWeight] = useState<AdvancedStyleWeight>('medium')
  const [advancedSketchWeight, setAdvancedSketchWeight] = useState<AdvancedSketchWeight>('reference')
  const [simplePrompt, setSimplePrompt] = useState('')
  const [advancedPrompt, setAdvancedPrompt] = useState('')
  const [simplePromptOptimizationPreset, setSimplePromptOptimizationPreset] =
    useState<PromptOptimizationPreset>(DEFAULT_PROMPT_OPTIMIZATION_PRESET)
  const [advancedPromptOptimizationPreset, setAdvancedPromptOptimizationPreset] =
    useState<PromptOptimizationPreset>(DEFAULT_PROMPT_OPTIMIZATION_PRESET)
  const [advancedSketchDescription, setAdvancedSketchDescription] = useState('')
  const [advancedSketchImageDataUrl, setAdvancedSketchImageDataUrl] = useState('')
  const [isAdvancedSketchDirty, setIsAdvancedSketchDirty] = useState(false)
  const [isAnalyzingAdvancedSketch, setIsAnalyzingAdvancedSketch] = useState(false)
  const [advancedStyleCategory, setAdvancedStyleCategory] = useState('')
  const [advancedSelectedStyleId, setAdvancedSelectedStyleId] = useState('')
  const [commerceProductImages, setCommerceProductImages] = useState<ReferenceImage[]>([])
  const [commerceStyleImage, setCommerceStyleImage] = useState<ReferenceImage | null>(null)
  const [commerceDescription, setCommerceDescription] = useState('')
  const [commerceGenerateKind, setCommerceGenerateKind] = useState<'main' | 'detail'>('main')
  const [commerceCategoryMode, setCommerceCategoryMode] = useState<'preset' | 'custom'>('preset')
  const [commerceCategoryLevel1, setCommerceCategoryLevel1] = useState('')
  const [commerceCategoryLevel2, setCommerceCategoryLevel2] = useState('')
  const [commerceCategoryLevel3, setCommerceCategoryLevel3] = useState('')
  const [commerceCustomCategory, setCommerceCustomCategory] = useState('')
  const [canvases, setCanvases] = useState<WorkflowCanvas[]>(loadWorkflowCanvases)
  const [activeCanvasId, setActiveCanvasId] = useState(loadActiveCanvasId)
  const [renamingCanvasId, setRenamingCanvasId] = useState<string | null>(null)
  const [renamingCanvasName, setRenamingCanvasName] = useState('')
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isQuickGenerating, setIsQuickGenerating] = useState(false)
  const [isAdvancedGenerating, setIsAdvancedGenerating] = useState(false)
  const [isCommerceGenerating, setIsCommerceGenerating] = useState(false)
  const [isOptimizingSimplePrompt, setIsOptimizingSimplePrompt] = useState(false)
  const [isOptimizingNegativePrompt, setIsOptimizingNegativePrompt] = useState(false)
  const [optimizingPromptNodeIds, setOptimizingPromptNodeIds] = useState<Set<string>>(
    () => new Set()
  )
  const [images, setImages] = useState<LocalImageRecord[]>([])
  const [previewImage, setPreviewImage] = useState<LocalImageRecord | null>(null)
  const [galleryReferencePickerNodeId, setGalleryReferencePickerNodeId] = useState('')
  const [selectingGalleryReferenceImageId, setSelectingGalleryReferenceImageId] = useState('')
  const [status, setStatus] = useState('未连接')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null)
  const [generationSuccess, setGenerationSuccess] = useState<{
    title: string
    message: string
  } | null>(null)
  const [paneMenu, setPaneMenu] = useState<PaneMenu>(null)
  const [isSidebarDrawerOpen, setIsSidebarDrawerOpen] = useState(false)
  const [isCanvasDrawerOpen, setIsCanvasDrawerOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia(CANVAS_DRAWER_AUTO_OPEN_QUERY).matches
  )
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<WorkflowNode, WorkflowEdge> | null>(null)
  const loadedStyleCategoriesRef = useRef(new Set<string>())
  const loadingStyleCategoriesRef = useRef(new Set<string>())
  const lastSavedReferenceImageBlobSignatureRef = useRef('')
  const hasManuallyToggledCanvasDrawerRef = useRef(false)
  const canvasListRenameInputRef = useRef<HTMLInputElement | null>(null)
  const advancedSketchCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDrawingAdvancedSketchRef = useRef(false)
  const lastAdvancedSketchPointRef = useRef<{ x: number; y: number } | null>(null)
  const commerceCategoryLevel1Node = commerceCategoryTree.find((item) => item.name === commerceCategoryLevel1)
  const commerceCategoryLevel2Options = commerceCategoryLevel1Node?.children || []
  const commerceCategoryLevel2Node = commerceCategoryLevel2Options.find((item) => item.name === commerceCategoryLevel2)
  const commerceCategoryLevel3Options = commerceCategoryLevel2Node?.children || []
  const selectedCommerceCategoryPath = [
    commerceCategoryLevel1,
    commerceCategoryLevel2,
    commerceCategoryLevel3,
  ].filter(Boolean).join(' / ')
  const effectiveCommerceCategoryPath =
    commerceCategoryMode === 'custom' ? commerceCustomCategory.trim() : selectedCommerceCategoryPath

  const activeCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === activeCanvasId) || canvases[0],
    [activeCanvasId, canvases]
  )
  const nodes = activeCanvas?.nodes || []
  const edges = activeCanvas?.edges || []
  const generationMode = activeCanvas?.generationMode || 'text'
  const referenceImages = useMemo(() => getCanvasReferenceImages(activeCanvas), [activeCanvas])
  const activeCanvasGenerating = activeCanvas ? isCanvasGenerating(activeCanvas) : false
  const referenceImageBlobs = useMemo(
    () => extractReferenceImageBlobs(canvases),
    [canvases]
  )
  const referenceImageBlobSignature = useMemo(
    () => referenceImageBlobs.map((blob) => `${blob.id}:${blob.dataUrl}`).join('|'),
    [referenceImageBlobs]
  )
  const styleOptions = useMemo(() => {
    const loadedById = new Map(styles.map((style) => [style.id, style]))
    return styleSummaries.map((style) => loadedById.get(style.id) || style)
  }, [styleSummaries, styles])

  const advancedVisibleStyles = useMemo(
    () =>
      advancedStyleCategory
        ? styleOptions.filter((style) => style.category === advancedStyleCategory)
        : [],
    [advancedStyleCategory, styleOptions]
  )
  const advancedSelectedStyle = useMemo(
    () => styleOptions.find((style) => style.id === advancedSelectedStyleId) || null,
    [advancedSelectedStyleId, styleOptions]
  )
  const advancedStyleKeywords = advancedSelectedStyle?.keywords?.slice(0, 6) || []
  const isConfigured = Boolean(imageBaseUrl.trim() && apiKey.trim() && model.trim())
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

  const setPromptNodePrompt = useCallback(
    (nodeId: string, updater: StateUpdater<string>) => {
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id !== nodeId || node.type !== 'prompt') return node

          const nextPrompt = resolveUpdater(updater, getWorkflowNodePrompt(node))
          return {
            ...node,
            data: {
              ...node.data,
              prompt: nextPrompt,
            },
          }
        })
      )
    },
    [setNodes]
  )

  const setPromptNodeOptimizationPreset = useCallback(
    (nodeId: string, nextPreset: PromptOptimizationPreset) => {
      setNodes((currentNodes) =>
        currentNodes.map((node) =>
          node.id === nodeId && node.type === 'prompt'
            ? {
                ...node,
                data: {
                  ...node.data,
                  promptOptimizationPreset: nextPreset,
                },
              }
            : node
        )
      )
    },
    [setNodes]
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
          const nextImages = normalizeAssetNodeReferenceImages(resolveUpdater(updater, currentImages))

          return {
            ...node,
            data: nextImages.length > 0 ? { referenceImages: nextImages } : {},
          }
        }),
      }))
    },
    [updateActiveCanvas]
  )

  const setStyleNodeSelection = useCallback(
    (nodeId: string, selectedStyleId: string) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        nodes: canvas.nodes.map((node) =>
          node.id === nodeId && node.type === 'style'
            ? {
                ...node,
                data: selectedStyleId ? { selectedStyleId } : {},
              }
            : node
        ),
      }))
      const style = styleOptions.find((item) => item.id === selectedStyleId)
      setStatus(style ? `已选择风格：${style.name}` : '风格已清空')
    },
    [styleOptions, updateActiveCanvas]
  )

  const loadStyleCategory = useCallback(
    async (categoryName: string) => {
      if (!categoryName) return
      if (loadedStyleCategoriesRef.current.has(categoryName)) return
      if (loadingStyleCategoriesRef.current.has(categoryName)) return

      const category = styleCategories.find((item) => item.name === categoryName)
      if (!category) return

      loadingStyleCategoriesRef.current.add(categoryName)
      setIsLoadingStyles(true)
      try {
        const result = await bridge.listStyleCategory(category)
        const loadedStyles = result.styles
        setStyles((current) => {
          const nextById = new Map(current.map((style) => [style.id, style]))
          loadedStyles.forEach((style) => nextById.set(style.id, style))
          return [...nextById.values()]
        })
        setStyleSummaries((current) => {
          const nextById = new Map(current.map((style) => [style.id, style]))
          loadedStyles.forEach((style) => nextById.set(style.id, style))
          return [...nextById.values()]
        })
        loadedStyleCategoriesRef.current.add(categoryName)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus(message)
      } finally {
        loadingStyleCategoriesRef.current.delete(categoryName)
        setIsLoadingStyles(loadingStyleCategoriesRef.current.size > 0)
      }
    },
    [styleCategories]
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

  useEffect(() => {
    void getSettings()
      .then((settings) => {
        setTextBaseUrl(settings.textBaseUrl || settings.baseUrl || DEFAULT_TEXT_BASE_URL)
        setImageBaseUrl(settings.imageBaseUrl || settings.baseUrl || DEFAULT_IMAGE_BASE_URL)
        setImageRetryCount(normalizeImageRetryCount(settings.imageRetryCount))
        setPersistApiKey(Boolean(settings.persistApiKey))
        setThemeMode(settings.themeMode || 'system')
        setTextModel(settings.textModel || DEFAULT_TEXT_MODEL)
        if (settings.persistApiKey && settings.apiKey) setApiKey(settings.apiKey)
        if (settings.persistApiKey && settings.codexApiKey) setCodexApiKey(settings.codexApiKey)
      })
      .finally(() => setHasLoadedSettings(true))
    void refreshImages()
  }, [])

  useEffect(() => {
    if (!hasLoadedSettings) return
    void recoverImageTasks()
  }, [hasLoadedSettings])

  useEffect(() => {
    if (!hasLoadedSettings || isConfigured || currentView === 'console') return
    setError('')
    setCurrentView('console')
  }, [currentView, hasLoadedSettings, isConfigured])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (isConfigured) setNotice(null)
  }, [isConfigured])

  useEffect(() => {
    const mediaQuery = window.matchMedia(CANVAS_DRAWER_AUTO_OPEN_QUERY)
    setIsCanvasDrawerOpen(mediaQuery.matches)

    function syncCanvasDrawerState(event: MediaQueryListEvent) {
      if (hasManuallyToggledCanvasDrawerRef.current) return
      setIsCanvasDrawerOpen(event.matches)
    }

    mediaQuery.addEventListener('change', syncCanvasDrawerState)
    return () => mediaQuery.removeEventListener('change', syncCanvasDrawerState)
  }, [])

  useEffect(() => {
    if (!isSidebarDrawerOpen) return

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsSidebarDrawerOpen(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isSidebarDrawerOpen])

  useEffect(() => {
    let cancelled = false
    setIsLoadingStyles(true)
    void bridge.listStyles()
      .then((library) => {
        if (cancelled) return
        setStyles([])
        setStyleSummaries(
          library.styles.map((style) => ({ ...style, styleJson: style.styleJson || {} }))
        )
        setStyleCategories(library.categories)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setStatus(message)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingStyles(false)
      })

    return () => {
      cancelled = true
    }
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
    if (!renamingCanvasId) return
    canvasListRenameInputRef.current?.focus()
    canvasListRenameInputRef.current?.select()
  }, [renamingCanvasId])

  useEffect(() => {
    if (currentView !== 'advanced') return
    initializeAdvancedSketchCanvas()
  }, [currentView])

  useEffect(() => {
    if (!advancedSelectedStyle) return
    if (advancedSelectedStyle.category !== advancedStyleCategory) {
      setAdvancedStyleCategory(advancedSelectedStyle.category)
    }
  }, [advancedSelectedStyle, advancedStyleCategory])

  useEffect(() => {
    if (!advancedStyleCategory) return
    void loadStyleCategory(advancedStyleCategory)
  }, [advancedStyleCategory, loadStyleCategory])

  useEffect(() => {
    if (!advancedSelectedStyleId) return
    if (!styles.some((style) => style.id === advancedSelectedStyleId)) {
      setAdvancedSelectedStyleId('')
    }
  }, [advancedSelectedStyleId, styles])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        WORKFLOW_CANVASES_STORAGE_KEY,
        JSON.stringify(serializeWorkflowCanvases(canvases))
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/quota/i.test(message)) {
        setStatus('画布已切换到磁盘缓存保存')
      } else {
        setError(message)
      }
    }
  }, [canvases])

  useEffect(() => {
    let cancelled = false

    void listReferenceImageBlobs()
      .then((blobs) => {
        if (cancelled || blobs.length === 0) return
        setCanvases((current) => hydrateWorkflowCanvases(current, blobs))
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (referenceImageBlobSignature === lastSavedReferenceImageBlobSignatureRef.current) return
    lastSavedReferenceImageBlobSignatureRef.current = referenceImageBlobSignature
    void saveReferenceImageBlobs(referenceImageBlobs)
  }, [referenceImageBlobSignature, referenceImageBlobs])

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
      generationTaskId?: string
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
      generationTaskId: context.generationTaskId,
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
      generateNodeId?: string
      generationTaskId?: string
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
                nodes: context.generateNodeId
                  ? canvas.nodes.map((node) =>
                      node.id === context.generateNodeId && node.type === 'generate'
                        ? {
                            ...node,
                            data: {
                              ...node.data,
                              latestImageId: records[0].id,
                            },
                          }
                        : node
                    )
                  : canvas.nodes,
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
    return records
  }

  async function imageTaskResultToImages(task: ImageGenerationTask) {
    const generatedImages: Array<{ src: string; revisedPrompt?: string }> = []
    for (const item of task.result?.data || []) {
      if (item.b64_json) {
        generatedImages.push({
          src: `data:image/png;base64,${item.b64_json}`,
          revisedPrompt: item.revised_prompt,
        })
      } else if (item.url) {
        generatedImages.push({
          src: await imageSourceToDataUrl(item.url),
          revisedPrompt: item.revised_prompt,
        })
      }
    }
    return generatedImages
  }

  async function importCompletedImageTask(
    task: ImageGenerationTask,
    savedTaskIds: Set<string>
  ) {
    if (savedTaskIds.has(task.taskId)) return 0
    if (task.status !== 'completed' || !task.result || !task.request?.prompt) return 0
    if (task.fallbackUsed && task.request.mode === 'text' && task.request.referenceImageNames?.length) {
      savedTaskIds.add(task.taskId)
      return 0
    }

    const generatedImages = await imageTaskResultToImages(task)
    if (generatedImages.length === 0) return 0

    await saveImages(
      buildLocalImageRecords(generatedImages, {
        prompt: task.request.prompt || '',
        model: task.request.model || model,
        size: task.request.size || selectedGenerationSize() || 'auto',
        quality: task.request.quality || quality,
        mode: task.request.mode || 'text',
        referenceImageNames: task.request.referenceImageNames,
        generationTaskId: task.taskId,
      })
    )
    savedTaskIds.add(task.taskId)
    return generatedImages.length
  }

  async function monitorRecoveredImageTask(
    initialTask: ImageGenerationTask,
    savedTaskIds: Set<string>
  ) {
    let task = initialTask
    while (task.status === 'queued' || task.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, task.pollAfterMs || 1500))
      task = await bridge.getImageTask(task.taskId)
      setStatus(taskStatusLabel(task.status))
    }
    if (await importCompletedImageTask(task, savedTaskIds)) {
      await refreshImages()
      setStatus('已恢复后台完成的图片任务，结果已保存到图库')
    }
  }

  async function recoverImageTasks() {
    try {
      const [tasks, currentImages] = await Promise.all([bridge.listImageTasks(), listImages()])
      const savedTaskIds = new Set(
        currentImages
          .map((image) => image.generationTaskId)
          .filter((taskId): taskId is string => Boolean(taskId))
      )

      for (const task of tasks) {
        if (task.status === 'completed') {
          await importCompletedImageTask(task, savedTaskIds)
        } else if (task.status === 'queued' || task.status === 'running') {
          void monitorRecoveredImageTask(task, savedTaskIds)
        }
      }
      await refreshImages()
    } catch (err) {
      console.warn('Failed to recover image tasks:', err)
    }
  }

  async function handleSaveSettings() {
    await saveSettings({
      baseUrl: imageBaseUrl,
      textBaseUrl,
      imageBaseUrl,
      persistApiKey,
      apiKey,
      codexApiKey,
      imageRetryCount,
      textModel,
      themeMode,
    })
    setStatus(persistApiKey ? '设置已保存' : '设置已保存，API Key 未落盘')
  }

  async function handleResetConnectionSettings() {
    setError('')
    setTextBaseUrl(DEFAULT_TEXT_BASE_URL)
    setImageBaseUrl(DEFAULT_IMAGE_BASE_URL)
    setApiKey('')
    setCodexApiKey('')
    setImageRetryCount(DEFAULT_IMAGE_RETRY_COUNT)
    setPersistApiKey(false)
    setModel(DEFAULT_MODEL)
    setTextModel(DEFAULT_TEXT_MODEL)
    setModels([])
    setLoginPassword('')
    setIsLoginDialogOpen(false)
    await saveSettings({
      baseUrl: DEFAULT_IMAGE_BASE_URL,
      textBaseUrl: DEFAULT_TEXT_BASE_URL,
      imageBaseUrl: DEFAULT_IMAGE_BASE_URL,
      persistApiKey: false,
      apiKey: '',
      codexApiKey: '',
      imageRetryCount: DEFAULT_IMAGE_RETRY_COUNT,
      textModel: DEFAULT_TEXT_MODEL,
      themeMode,
    })
    setStatus('连接配置已重设，API Key 已清除')
  }

  async function handleThemeChange(nextThemeMode: ThemeMode) {
    setThemeMode(nextThemeMode)
    await saveSettings({
      baseUrl: imageBaseUrl,
      textBaseUrl,
      imageBaseUrl,
      persistApiKey,
      apiKey,
      codexApiKey,
      imageRetryCount,
      textModel,
      themeMode: nextThemeMode,
    })
    setStatus('主题已切换')
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
      setTextBaseUrl(settings.textBaseUrl || settings.baseUrl || DEFAULT_TEXT_BASE_URL)
      setImageBaseUrl(settings.imageBaseUrl || settings.baseUrl || DEFAULT_IMAGE_BASE_URL)
      setImageRetryCount(normalizeImageRetryCount(settings.imageRetryCount))
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

    const selectedFile = imageFiles[0]
    if (!selectedFile) return
    const baseTitle = referenceTitleFromFileName(selectedFile.name, 0)

    const nextImage: ReferenceImage = {
      id: createLocalId('reference'),
      name: selectedFile.name,
      title: createUniqueReferenceTitle(baseTitle, getCanvasReferenceNameEntries(activeCanvas)),
      type: selectedFile.type || 'image/png',
      dataUrl: await fileToDataUrl(selectedFile),
    }

    setAssetNodeReferenceImages(nodeId, [nextImage])
    setGenerationMode('image')
    if (imageFiles.length > 1) {
      setStatus('每个参考图节点只能放 1 张图片，已保留第一张')
    }
  }

  async function selectGalleryReferenceImage(nodeId: string, image: LocalImageRecord) {
    if (selectingGalleryReferenceImageId) return

    setSelectingGalleryReferenceImageId(image.id)
    try {
      const dataUrl = await imageSourceToDataUrl(image.src)
      const type = mimeTypeFromDataUrl(dataUrl)
      const baseTitle =
        normalizeReferenceTitle(image.revisedPrompt || image.prompt) || '图库图片'
      const nextImage: ReferenceImage = {
        id: createLocalId('reference'),
        name: `${baseTitle}.${imageExtensionFromMimeType(type)}`,
        title: createUniqueReferenceTitle(
          baseTitle,
          getCanvasReferenceNameEntries(activeCanvas).filter(
            (entry) => entry.nodeId !== nodeId
          )
        ),
        type,
        dataUrl,
      }

      setAssetNodeReferenceImages(nodeId, [nextImage])
      setGenerationMode('image')
      setGalleryReferencePickerNodeId('')
      setStatus('已从图库选择参考图')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('选择图库参考图失败')
    } finally {
      setSelectingGalleryReferenceImageId('')
    }
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
    const currentNode = nodes.find(
      (node) => node.id === nodeId && node.type === 'asset'
    )
    const currentImage = getWorkflowNodeReferenceImages(currentNode).find(
      (image) => image.id === id
    )
    const nextTitle =
      normalizeReferenceTitle(title) ||
      normalizeReferenceTitle(currentImage?.name || '') ||
      '参考图'
    if (
      activeCanvas &&
      isReferenceTitleTaken(activeCanvas, nextTitle, referenceImageOwnerId(id))
    ) {
      setError(`画布内已存在图片名称：${nextTitle}`)
      setStatus('图片名称不能重复')
      return
    }

    setError('')
    setAssetNodeReferenceImages(nodeId, (current) =>
      current.map((image) =>
        image.id === id ? { ...image, title: nextTitle } : image
      )
    )
  }

  function updateGenerateNodeOutputTitle(nodeId: string, title: string) {
    const nextTitle = normalizeReferenceTitle(title) || defaultGenerateOutputTitle(nodeId)
    if (
      activeCanvas &&
      isReferenceTitleTaken(activeCanvas, nextTitle, generateOutputOwnerId(nodeId))
    ) {
      setError(`画布内已存在图片名称：${nextTitle}`)
      setStatus('图片名称不能重复')
      return
    }

    setError('')
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === nodeId && node.type === 'generate'
          ? {
              ...node,
              data: {
                ...node.data,
                outputTitle: nextTitle,
              },
            }
          : node
      )
    )
  }

  async function handleFetchModels() {
    setError('')
    setStatus('正在获取模型...')
    setIsLoadingModels(true)

    try {
      const nextModels = await bridge.listModels({ baseUrl: imageBaseUrl, apiKey })
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

      setTextBaseUrl(result.baseUrl)
      setImageBaseUrl(result.baseUrl)
      setApiKey(result.apiKey)
      setCodexApiKey(result.codexApiKey)
      setImageRetryCount(DEFAULT_IMAGE_RETRY_COUNT)
      setPersistApiKey(true)
      setModel(result.model || DEFAULT_MODEL)
      setTextModel(result.codexModel || DEFAULT_TEXT_MODEL)
      await saveSettings({
        baseUrl: result.baseUrl,
        textBaseUrl: result.baseUrl,
        imageBaseUrl: result.baseUrl,
        persistApiKey: true,
        apiKey: result.apiKey,
        codexApiKey: result.codexApiKey,
        imageRetryCount: DEFAULT_IMAGE_RETRY_COUNT,
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

  async function handleOptimizePrompt(promptNodeId: string) {
    const promptNode = nodes.find((node) => node.id === promptNodeId && node.type === 'prompt')
    const currentPrompt = getWorkflowNodePrompt(promptNode).trim()
    const promptOptimizationPreset = getWorkflowNodePromptOptimizationPreset(promptNode)
    if (!currentPrompt) {
      setError('请先输入需要优化的提示词')
      return
    }
    if (!codexApiKey.trim()) {
      setError('请先在控制台填写文本模型 API Key，或点击连接配置里的登录获取文本模型秘钥')
      setStatus('缺少提示词优化秘钥')
      return
    }

    setError('')
    if (optimizingPromptNodeIds.has(promptNodeId)) return

    setStatus('正在优化提示词...')
    setOptimizingPromptNodeIds((current) => new Set(current).add(promptNodeId))

    try {
      const promptReferenceImages = getPromptMentionReferenceImages(
        promptNodeId,
        activeCanvas,
        images
      )
      const protectedPrompt = protectPromptMentionsForOptimization(
        currentPrompt,
        promptReferenceImages
      )
      const optimizedPrompt = await bridge.optimizePrompt({
        baseUrl: textBaseUrl,
        apiKey: codexApiKey,
        model: textModel.trim() || DEFAULT_TEXT_MODEL,
        prompt: protectedPrompt.prompt,
        mode: generationMode,
        optimizationPreset: promptOptimizationPreset,
      })
      setPromptNodePrompt(
        promptNodeId,
        normalizeOptimizedPromptMentions(
          optimizedPrompt,
          promptReferenceImages,
          protectedPrompt.mentions
        )
      )
      setStatus('提示词已优化')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('提示词优化失败')
    } finally {
      setOptimizingPromptNodeIds((current) => {
        const next = new Set(current)
        next.delete(promptNodeId)
        return next
      })
    }
  }

  async function handleOptimizeSimplePrompt(target: 'simple' | 'advanced' = 'simple') {
    const currentPrompt = (target === 'advanced' ? advancedPrompt : simplePrompt).trim()
    if (!currentPrompt) {
      setError('请先输入需要优化的图片描述')
      return
    }
    if (!codexApiKey.trim()) {
      setError('请先在控制台填写文本模型 API Key，或点击连接配置里的登录获取文本模型秘钥')
      setStatus('缺少提示词优化秘钥')
      return
    }
    if (isOptimizingSimplePrompt) return

    setError('')
    setStatus('正在优化提示词...')
    setIsOptimizingSimplePrompt(true)

    try {
      const optimizedPrompt = await bridge.optimizePrompt({
        baseUrl: textBaseUrl,
        apiKey: codexApiKey,
        model: textModel.trim() || DEFAULT_TEXT_MODEL,
        prompt: currentPrompt,
        mode: 'text',
        optimizationPreset:
          target === 'advanced'
            ? advancedPromptOptimizationPreset
            : simplePromptOptimizationPreset,
      })
      if (target === 'advanced') {
        setAdvancedPrompt(optimizedPrompt)
      } else {
        setSimplePrompt(optimizedPrompt)
      }
      setStatus('提示词已优化')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('提示词优化失败')
    } finally {
      setIsOptimizingSimplePrompt(false)
    }
  }

  async function handleOptimizeAdvancedNegativePrompt() {
    const currentPrompt = advancedPrompt.trim()
    if (!currentPrompt) {
      setError('请先填写图片描述，再优化负面提示词')
      setStatus('缺少图片描述')
      return
    }
    if (!codexApiKey) {
      setError('请先点击连接配置里的登录，获取 gpt 2 分组秘钥')
      setStatus('缺少提示词优化秘钥')
      return
    }
    if (isOptimizingNegativePrompt) return

    setError('')
    setStatus('正在优化负面提示词...')
    setIsOptimizingNegativePrompt(true)

    try {
      const optimizedNegativePrompt = await bridge.optimizeNegativePrompt({
        baseUrl: textBaseUrl,
        apiKey: codexApiKey,
        model: textModel.trim() || DEFAULT_TEXT_MODEL,
        prompt: currentPrompt,
        currentNegativePrompt: advancedNegativePrompt,
      })
      setAdvancedNegativePrompt(optimizedNegativePrompt)
      setStatus('负面提示词已优化')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('负面提示词优化失败')
    } finally {
      setIsOptimizingNegativePrompt(false)
    }
  }

  async function handleGenerate(targetGenerateNodeId?: string) {
    const generatingCanvasId = activeCanvas?.id
    const duplicateTitles = getDuplicateCanvasReferenceTitles(activeCanvas)
    if (duplicateTitles.length > 0) {
      setError(`画布内图片名称重复：${duplicateTitles.join('、')}`)
      setStatus('请先修改重复的图片名称')
      return
    }
    const generationSize = selectedGenerationSize()
    if (!generationSize) {
      setError('请输入 64 到 4096 之间的自定义宽高')
      return
    }
    setError('')
    const generatedRecordsByNode = new Map<string, LocalImageRecord[]>()

    const generateNodes = nodes.filter((node) => node.type === 'generate')
    const targetNode =
      (targetGenerateNodeId
        ? generateNodes.find((node) => node.id === targetGenerateNodeId)
        : generateNodes[0]) || null

    try {
      if (!targetNode) throw new Error('当前画布没有图片生成节点')

      const executeGenerateNode = async (
        generateNode: WorkflowNode,
        visiting: Set<string>
      ): Promise<LocalImageRecord[]> => {
        const cachedRecords = generatedRecordsByNode.get(generateNode.id)
        if (cachedRecords) return cachedRecords
        if (visiting.has(generateNode.id)) {
          throw new Error('流程图中存在图片生成循环连接，请断开循环后重试')
        }

        visiting.add(generateNode.id)
        const promptEdge = edges.find(
          (edge) =>
            edge.target === generateNode.id &&
            edge.targetHandle === 'prompt' &&
            nodes.find((node) => node.id === edge.source)?.type === 'prompt'
        )
        const promptNode =
          (promptEdge ? nodes.find((node) => node.id === promptEdge.source) : null) ||
          nodes.find((node) => node.type === 'prompt') ||
          null
        if (!promptNode) throw new Error('请先创建文字描述节点并连接到图片生成节点')
        const finalPrompt = getWorkflowNodePrompt(promptNode).trim()
        if (!finalPrompt) throw new Error('请先输入提示词')

        const styleNodes = nodes.filter((node) => node.type === 'style')
        const selectedStyleIdsInCanvas = styleNodes
          .map((node) => getWorkflowNodeSelectedStyleId(node))
          .filter(Boolean)
        const missingStyleCategoryNames = [
          ...new Set(
            selectedStyleIdsInCanvas
              .map(
                (styleId) =>
                  styleSummaries.find((style) => style.id === styleId)?.category || ''
              )
              .filter(
                (categoryName) =>
                  categoryName && !loadedStyleCategoriesRef.current.has(categoryName)
              )
          ),
        ]
        for (const categoryName of missingStyleCategoryNames) {
          await loadStyleCategory(categoryName)
        }

        const upstreamGenerateEdges = edges.filter(
          (edge) =>
            edge.target === promptNode.id &&
            edge.sourceHandle === 'generated-image' &&
            (edge.targetHandle === 'reference' || edge.targetHandle?.startsWith('reference-')) &&
            nodes.find((node) => node.id === edge.source)?.type === 'generate'
        )
        const upstreamReferenceImages: ReferenceImage[] = []
        for (const edge of upstreamGenerateEdges) {
          const upstreamNode = nodes.find((node) => node.id === edge.source)
          if (!upstreamNode) continue
          setStatus(`正在先执行上游图片生成：${upstreamNode.id}`)
          const upstreamRecords = await executeGenerateNode(upstreamNode, visiting)
          const firstRecord = upstreamRecords[0]
          if (!firstRecord) continue
          const outputTitle = getWorkflowNodeOutputTitle(upstreamNode)
          upstreamReferenceImages.push({
            id: `generated-${firstRecord.id}`,
            name: `${outputTitle}.png`,
            title: outputTitle,
            type: 'image/png',
            dataUrl: firstRecord.src,
          })
        }

        const promptReferenceImages = getPromptAssetReferenceImages(promptNode.id, activeCanvas)
        const availableReferenceImages = [
          ...promptReferenceImages,
          ...upstreamReferenceImages,
        ]
        const resolvedReferences = resolvePromptReferenceImages(finalPrompt, availableReferenceImages)
        const hasGeneratedPromptConnection = upstreamGenerateEdges.length > 0
        const mentionsGeneratedReference = resolvedReferences.images.some((image) =>
          upstreamReferenceImages.some((referenceImage) => referenceImage.id === image.id)
        )
        if (mentionsGeneratedReference && !hasGeneratedPromptConnection) {
          throw new Error('请先把图片生成节点连接到文字描述节点，再使用 @引用生成图')
        }
        if (resolvedReferences.missing.length > 0) {
          throw new Error(`没有找到这些 @参考图：${resolvedReferences.missing.join('、')}`)
        }

        const selectedStyleIds = getPromptSelectedStyleIds(promptNode.id, activeCanvas)
        const selectedStyles = selectedStyleIds
          .map((styleId) => styles.find((style) => style.id === styleId))
          .filter((style): style is StyleOption => Boolean(style))
        if (selectedStyleIds.length > 0 && selectedStyles.length < selectedStyleIds.length) {
          throw new Error('风格协议仍在加载，请稍后重试')
        }
        const submittedPrompt = promptWithStyles(finalPrompt, selectedStyles)
        const flowReferenceImages = [...resolvedReferences.images, ...upstreamReferenceImages]
          .filter((image, index, list) => list.findIndex((item) => item.id === image.id) === index)
        const effectiveGenerationMode: 'text' | 'image' =
          flowReferenceImages.length > 0 ? 'image' : 'text'
        const referenceImageNames =
          effectiveGenerationMode === 'image'
            ? flowReferenceImages.map((image) => image.title || image.name)
            : undefined
        const generationContext = {
          prompt: submittedPrompt,
          model,
          size: generationSize,
          quality,
          mode: effectiveGenerationMode,
          referenceImageNames,
          canvasId: generatingCanvasId || undefined,
          generateNodeId: generateNode.id,
        }

        setStatus(
          effectiveGenerationMode === 'image'
            ? `正在执行 ${generateNode.id}，使用 ${flowReferenceImages.length} 张参考图${selectedStyles.length > 0 ? `和 ${selectedStyles.length} 个风格` : ''}...`
            : selectedStyles.length > 0
              ? `正在执行 ${generateNode.id}，使用 ${selectedStyles.length} 个风格...`
              : `正在执行 ${generateNode.id}...`
        )
        let currentTaskId = ''
        const result = await bridge.generateImages({
          baseUrl: imageBaseUrl,
          apiKey,
          mode: effectiveGenerationMode,
          model,
          prompt: submittedPrompt,
          size: generationSize,
          quality,
          count,
          responseFormat,
          inputFidelity,
          retryCount: imageRetryCount,
          referenceImages:
            effectiveGenerationMode === 'image' ? flowReferenceImages : undefined,
          onTaskUpdate: (task) => {
            currentTaskId = task.taskId
            if (generationContext.canvasId) {
              if (task.status === 'queued' || task.status === 'running') {
                setCanvasGenerationTask(generationContext.canvasId, task)
              } else {
                clearCanvasGenerationTask(generationContext.canvasId)
              }
            }
            setStatus(taskStatusLabel(task.status))
          },
        })

        if (!currentTaskId) {
          throw new Error('任务提交成功，但没有返回任务 ID')
        }
        const records = await persistCompletedTaskResult(
          currentTaskId,
          result.images,
          { ...generationContext, generationTaskId: currentTaskId }
        )
        generatedRecordsByNode.set(generateNode.id, records)
        visiting.delete(generateNode.id)
        return records
      }

      const records = await executeGenerateNode(targetNode, new Set())
      setStatus(`已生成 ${records.length} 张图片，结果已保存到本地图库`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (generatingCanvasId) clearCanvasGenerationTask(generatingCanvasId)
      setStatus('生成失败')
    }
  }

  function enterConfiguredView(view: AppView) {
    if (view !== 'console' && !isConfigured) {
      setError('')
      setNotice({
        id: window.performance.now(),
        message: CONFIGURATION_NOTICE_MESSAGE,
      })
      setCurrentView('console')
      return
    }
    setError('')
    setNotice(null)
    setCurrentView(view)
  }

  function enterSidebarView(view: AppView) {
    enterConfiguredView(view)
    setIsSidebarDrawerOpen(false)
  }

  function selectedGenerationSizeFor(
    mode: 'preset' | 'custom',
    presetSize: string,
    customWidth: string,
    customHeight: string
  ) {
    if (mode === 'preset') return presetSize

    const width = Number(customWidth)
    const height = Number(customHeight)
    if (!Number.isInteger(width) || !Number.isInteger(height)) return ''
    if (width < 64 || height < 64 || width > 4096 || height > 4096) return ''
    return `${width}x${height}`
  }

  function selectedGenerationSize() {
    return selectedGenerationSizeFor(sizeMode, size, customSizeWidth, customSizeHeight)
  }

  function selectedAdvancedGenerationSize() {
    return selectedGenerationSizeFor(
      advancedSizeMode,
      advancedSize,
      advancedCustomSizeWidth,
      advancedCustomSizeHeight
    )
  }

  function handleSizeSelect(
    nextValue: string,
    state = {
      size,
      setSize,
      setSizeMode,
      setCustomSizeWidth,
      setCustomSizeHeight,
    }
  ) {
    if (nextValue === CUSTOM_SIZE_VALUE) {
      const parsedSize = parseSizeValue(state.size)
      if (parsedSize) {
        state.setCustomSizeWidth(String(parsedSize.width))
        state.setCustomSizeHeight(String(parsedSize.height))
      }
      state.setSizeMode('custom')
      return
    }

    state.setSizeMode('preset')
    state.setSize(nextValue)
  }

  function renderSizeField(
    state = {
      size,
      sizeMode,
      customSizeWidth,
      customSizeHeight,
      setSize,
      setSizeMode,
      setCustomSizeWidth,
      setCustomSizeHeight,
    }
  ) {
    return (
      <div className='field size-field'>
        <label className='size-select-label'>
          <span>尺寸</span>
          <select
            value={state.sizeMode === 'custom' ? CUSTOM_SIZE_VALUE : state.size}
            onChange={(event) => handleSizeSelect(event.target.value, state)}
          >
            {sizeOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {sizeOptionLabel(item)}
              </option>
            ))}
            <option value={CUSTOM_SIZE_VALUE}>自定义比例 · 手动输入</option>
          </select>
        </label>
        {state.sizeMode === 'custom' ? (
          <div className='custom-size-grid'>
            <label>
              <span>宽</span>
              <input
                type='number'
                min='64'
                max='4096'
                step='1'
                value={state.customSizeWidth}
                onChange={(event) => state.setCustomSizeWidth(event.target.value)}
                aria-label='自定义宽度'
              />
            </label>
            <label>
              <span>高</span>
              <input
                type='number'
                min='64'
                max='4096'
                step='1'
                value={state.customSizeHeight}
                onChange={(event) => state.setCustomSizeHeight(event.target.value)}
                aria-label='自定义高度'
              />
            </label>
          </div>
        ) : null}
      </div>
    )
  }

  function initializeAdvancedSketchCanvas() {
    const canvas = advancedSketchCanvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    canvas.width = ADVANCED_SKETCH_WIDTH
    canvas.height = ADVANCED_SKETCH_HEIGHT
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)

    if (advancedSketchImageDataUrl) {
      const image = new Image()
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
      }
      image.src = advancedSketchImageDataUrl
    }
  }

  function saveAdvancedSketchSnapshot(canvas: HTMLCanvasElement) {
    setAdvancedSketchImageDataUrl(canvas.toDataURL('image/png'))
  }

  function fillAdvancedSketchCanvasWhite() {
    const canvas = advancedSketchCanvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }

  function ensureAdvancedSketchCanvasReady() {
    const canvas = advancedSketchCanvasRef.current
    if (!canvas) return
    if (canvas.width !== ADVANCED_SKETCH_WIDTH || canvas.height !== ADVANCED_SKETCH_HEIGHT) {
      canvas.width = ADVANCED_SKETCH_WIDTH
      canvas.height = ADVANCED_SKETCH_HEIGHT
    }
    if (!isAdvancedSketchDirty && !advancedSketchImageDataUrl) {
      const context = canvas.getContext('2d')
      if (!context) return
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
  }

  function advancedSketchPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function drawAdvancedSketchLine(
    context: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ) {
    context.strokeStyle = '#101828'
    context.lineWidth = 5
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }

  function handleAdvancedSketchPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    ensureAdvancedSketchCanvasReady()
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = advancedSketchPoint(event)
    isDrawingAdvancedSketchRef.current = true
    lastAdvancedSketchPointRef.current = point
    drawAdvancedSketchLine(context, point, point)
    setIsAdvancedSketchDirty(true)
    setAdvancedSketchDescription('')
  }

  function handleAdvancedSketchPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!isDrawingAdvancedSketchRef.current) return
    const context = event.currentTarget.getContext('2d')
    const previousPoint = lastAdvancedSketchPointRef.current
    if (!context || !previousPoint) return
    const nextPoint = advancedSketchPoint(event)
    drawAdvancedSketchLine(context, previousPoint, nextPoint)
    lastAdvancedSketchPointRef.current = nextPoint
  }

  function stopAdvancedSketchDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    isDrawingAdvancedSketchRef.current = false
    lastAdvancedSketchPointRef.current = null
    saveAdvancedSketchSnapshot(event.currentTarget)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleClearAdvancedSketch() {
    fillAdvancedSketchCanvasWhite()
    setAdvancedSketchImageDataUrl('')
    setIsAdvancedSketchDirty(false)
    setAdvancedSketchDescription('')
  }

  function advancedSketchDataUrl() {
    if (!isAdvancedSketchDirty) return ''
    return advancedSketchCanvasRef.current?.toDataURL('image/png') || advancedSketchImageDataUrl
  }

  async function describeAdvancedSketch(prompt: string) {
    const sketchDataUrl = advancedSketchDataUrl()
    if (!sketchDataUrl) return ''
    if (!codexApiKey) {
      throw new Error('请先点击连接配置里的登录，获取用于识别草图的文本模型秘钥')
    }

    setStatus('正在识别分镜草图...')
    setIsAnalyzingAdvancedSketch(true)
    try {
      const description = await bridge.describeSketch({
        baseUrl: textBaseUrl,
        apiKey: codexApiKey,
        model: textModel.trim() || DEFAULT_TEXT_MODEL,
        prompt,
        sketchDataUrl,
        sketchWeight: advancedSketchWeight,
      })
      setAdvancedSketchDescription(description)
      return description
    } finally {
      setIsAnalyzingAdvancedSketch(false)
    }
  }

  function promptWithAdvancedSketch(prompt: string, sketchDescription: string) {
    const description = sketchDescription.trim()
    if (!description) return prompt
    return `${prompt}

【分镜草图约束】
${description}`
  }

  async function handleSimpleGenerate(options?: {
    includeAdvancedSketch?: boolean
    includeAdvancedStyle?: boolean
  }) {
    const includeAdvancedControls = Boolean(
      options?.includeAdvancedSketch || options?.includeAdvancedStyle
    )
    const prompt = (includeAdvancedControls ? advancedPrompt : simplePrompt).trim()
    if (!isConfigured) {
      setError('')
      setCurrentView('console')
      return
    }
    const generationSize = includeAdvancedControls
      ? selectedAdvancedGenerationSize()
      : selectedGenerationSize()
    if (!generationSize) {
      setError('请输入 64 到 4096 之间的自定义宽高')
      return
    }
    if (!prompt) {
      setError('请先输入图片描述')
      return
    }

    setError('')
    setGenerationSuccess(null)
    const setGenerating = includeAdvancedControls ? setIsAdvancedGenerating : setIsQuickGenerating
    setGenerating(true)
    setStatus('正在生成图片...')

    try {
      const controlledPrompt = includeAdvancedControls
        ? promptWithCreativity(
            promptWithBackground(
              promptWithNegativePrompt(prompt, advancedNegativePrompt),
              advancedBackground
            ),
            advancedCreativity
          )
        : prompt
      const sketchDescription = options?.includeAdvancedSketch
        ? await describeAdvancedSketch(controlledPrompt)
        : ''
      const sketchPrompt = promptWithAdvancedSketch(controlledPrompt, sketchDescription)
      const selectedStyles =
        options?.includeAdvancedStyle && advancedSelectedStyle ? [advancedSelectedStyle] : []
      const finalPrompt = promptWithStyles(sketchPrompt, selectedStyles, advancedStyleWeight)
      let currentTaskId = ''
      const result = await bridge.generateImages({
        baseUrl: imageBaseUrl,
        apiKey,
        mode: 'text',
        model: includeAdvancedControls ? advancedModel : model,
        prompt: finalPrompt,
        size: generationSize,
        quality: includeAdvancedControls ? advancedQuality : quality,
        count: includeAdvancedControls ? advancedCount : count,
        responseFormat: includeAdvancedControls ? advancedResponseFormat : responseFormat,
        background: includeAdvancedControls ? advancedBackground : undefined,
        retryCount: imageRetryCount,
        onTaskUpdate: (task) => {
          currentTaskId = task.taskId
          setStatus(taskStatusLabel(task.status))
        },
      })
      const records = buildLocalImageRecords(result.images, {
        prompt: finalPrompt,
        model: includeAdvancedControls ? advancedModel : model,
        size: generationSize,
        quality: includeAdvancedControls ? advancedQuality : quality,
        mode: 'text',
        generationTaskId: currentTaskId || undefined,
      })
      await saveImages(records)
      await refreshImages()
      setStatus(`已生成 ${records.length} 张图片`)
      setGenerationSuccess({
        title: '生成完成',
        message: `${includeAdvancedControls ? '高级生成' : '快速生成'}已生成 ${records.length} 张图片，结果已保存到图库。`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setGenerationSuccess(null)
      setStatus('生成失败')
    } finally {
      setGenerating(false)
    }
  }

  async function handleCommerceImageFiles(kind: 'product' | 'style', files?: FileList | null) {
    const selectedFiles = Array.from(files || [])
    if (selectedFiles.length === 0) return
    const invalidFile = selectedFiles.find((file) => !file.type.startsWith('image/'))
    if (invalidFile) {
      setError('请上传图片文件')
      return
    }

    const limitedFiles =
      kind === 'product'
        ? selectedFiles.slice(0, Math.max(0, MAX_COMMERCE_PRODUCT_IMAGES - commerceProductImages.length))
        : selectedFiles.slice(0, 1)
    if (kind === 'product' && limitedFiles.length < selectedFiles.length) {
      setStatus(`商品白底图最多上传 ${MAX_COMMERCE_PRODUCT_IMAGES} 张，已保留前 ${limitedFiles.length} 张`)
    }
    if (limitedFiles.length === 0) return

    const images: ReferenceImage[] = await Promise.all(
      limitedFiles.map(async (file, index) => ({
        id: createLocalId(`commerce-${kind}-${index}`),
        name: file.name,
        title:
          kind === 'product'
            ? `商品白底图 ${commerceProductImages.length + index + 1}`
            : '目标风格图',
        type: 'image/jpeg',
        dataUrl: await fileToCommerceReferenceDataUrl(file),
      }))
    )

    setError('')
    if (kind === 'product') {
      setCommerceProductImages((current) =>
        [...current, ...images].slice(0, MAX_COMMERCE_PRODUCT_IMAGES).map((image, index) => ({
          ...image,
          title: `商品白底图 ${index + 1}`,
        }))
      )
    } else {
      setCommerceStyleImage(images[0])
    }
  }

  async function handleCommerceGenerate(kind: 'main' | 'detail') {
    const isDetail = kind === 'detail'
    const outputLabel = isDetail ? '电商详情图' : '电商主图'
    if (!isConfigured) {
      setError('')
      setCurrentView('console')
      return
    }
    const generationSize = selectedGenerationSize()
    if (!generationSize) {
      setError('请输入 64 到 4096 之间的自定义宽高')
      return
    }
    if (commerceProductImages.length === 0) {
      setError('请先上传至少 1 张商品白底图')
      return
    }
    if (!commerceStyleImage) {
      setError('请先上传目标风格图')
      return
    }
    if (!effectiveCommerceCategoryPath) {
      setError('请先选择完整的商品品类，或填写自定义商品品类')
      return
    }
    if (!codexApiKey) {
      setError(`请先点击连接配置里的登录，获取用于${isDetail ? '详情图' : '主图'}提示词预热的文本模型秘钥`)
      setStatus('缺少提示词预热秘钥')
      return
    }
    const description = commerceDescription.trim()

    setError('')
    setIsCommerceGenerating(true)
    setStatus(`正在分析目标${isDetail ? '详情' : ''}风格图...`)

    try {
      let preparedPrompt = ''
      try {
        const promptPayload = {
          baseUrl: textBaseUrl,
          apiKey: codexApiKey,
          model: textModel.trim() || DEFAULT_TEXT_MODEL,
          description,
          categoryPath: effectiveCommerceCategoryPath,
          productImages: commerceProductImages,
          styleImage: commerceStyleImage,
        }
        preparedPrompt = isDetail
          ? await bridge.prepareCommerceDetailPrompt(promptPayload)
          : await bridge.prepareCommerceMainPrompt(promptPayload)
      } catch (promptError) {
        const promptMessage = promptError instanceof Error ? promptError.message : String(promptError)
        console.warn('Commerce prompt preparation failed, falling back to local prompt:', promptMessage)
        setStatus('提示词预热失败，正在使用本地结构化提示词继续生成...')
      }
      const basePrompt = preparedPrompt.trim() || (isDetail ? buildCommerceDetailPrompt(description, effectiveCommerceCategoryPath) : buildCommerceMainPrompt(description, effectiveCommerceCategoryPath))
      const prompt = buildCommerceEditPrompt(basePrompt, commerceProductImages.length, kind)
      setStatus(
        commerceProductImages.length > 1
          ? '提示词预热完成，正在合成商品多角度参考图...'
          : `提示词预热完成，正在生成${outputLabel}...`
      )
      const productReferenceImage = await buildCommerceProductReferenceImage(commerceProductImages)
      const referenceImages = [productReferenceImage, commerceStyleImage]
      setStatus(`正在生成${outputLabel}...`)

      let currentTaskId = ''
      const result = await bridge.generateImages({
        baseUrl: imageBaseUrl,
        apiKey,
        mode: 'image',
        model,
        prompt,
        size: generationSize,
        quality,
        count,
        responseFormat,
        inputFidelity,
        retryCount: imageRetryCount,
        referenceImages,
        onTaskUpdate: (task) => {
          currentTaskId = task.taskId
          setStatus(taskStatusLabel(task.status))
        },
      })
      const records = buildLocalImageRecords(result.images, {
        prompt,
        model,
        size: generationSize,
        quality,
        mode: 'image',
        referenceImageNames: referenceImages.map((image) => image.title || image.name),
        generationTaskId: currentTaskId || undefined,
      })
      await saveImages(records)
      await refreshImages()
      setStatus(`已生成 ${records.length} 张${outputLabel}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('生成失败')
    } finally {
      setIsCommerceGenerating(false)
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
    downloadDataUrl(image.src, `${image.id || `gpt-image-${index + 1}`}.png`)
    setStatus('已触发图片下载；Codex 内置浏览器可能不支持下载，请在系统浏览器中打开后保存')
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

  function handleBeginCanvasRename(canvas: WorkflowCanvas) {
    setRenamingCanvasId(canvas.id)
    setRenamingCanvasName(canvas.name)
  }

  function handleCancelCanvasRename() {
    setRenamingCanvasId(null)
    setRenamingCanvasName('')
  }

  function handleCommitCanvasRename(id: string) {
    const canvas = canvases.find((item) => item.id === id)
    if (!canvas) {
      handleCancelCanvasRename()
      return
    }

    const nextName = renamingCanvasName.trim() || '未命名画布'
    if (nextName !== canvas.name) handleRenameCanvas(id, nextName)
    setRenamingCanvasId(null)
    setRenamingCanvasName('')
    setStatus(`${nextName} 已命名`)
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

  function handleCanvasRenameShortcut(
    event: ReactKeyboardEvent<HTMLInputElement>,
    id: string
  ) {
    event.stopPropagation()
    if (event.key === 'Enter') {
      handleCommitCanvasRename(id)
    }
    if (event.key === 'Escape') {
      handleCancelCanvasRename()
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

  function nodeDataFor(node: WorkflowNode): WorkflowNode['data'] {
    const type = node.type as WorkflowNodeType

    if (type === 'asset') {
      const nodeReferenceImages = getWorkflowNodeReferenceImages(node)

      return {
        onDeleteNode: deleteWorkflowNode,
        referenceImages: nodeReferenceImages,
        addReferenceFiles: (files: FileList | File[]) => addReferenceFiles(node.id, files),
        openGalleryPicker: () => setGalleryReferencePickerNodeId(node.id),
        galleryImageCount: images.length,
        removeReferenceImage: (id: string) => removeReferenceImage(node.id, id),
        updateReferenceImageTitle: (id: string, title: string) =>
          updateReferenceImageTitle(node.id, id, title),
        isReferenceTitleDuplicate: (id: string) => {
          const image = nodeReferenceImages.find((item) => item.id === id)
          if (!image) return false
          return isReferenceTitleTaken(
            activeCanvas,
            image.title || image.name,
            referenceImageOwnerId(id)
          )
        },
      }
    }

    if (type === 'prompt') {
      const nodePrompt = getWorkflowNodePrompt(node)
      const nodePromptOptimizationPreset = getWorkflowNodePromptOptimizationPreset(node)
      const promptReferenceImages = getPromptMentionReferenceImages(node.id, activeCanvas, images)
      const isPromptOptimizing = optimizingPromptNodeIds.has(node.id)

      return {
        onDeleteNode: deleteWorkflowNode,
        prompt: nodePrompt,
        setPrompt: (updater: StateUpdater<string>) => setPromptNodePrompt(node.id, updater),
        referenceImages: promptReferenceImages,
        optimizationPreset: nodePromptOptimizationPreset,
        optimizationPresets: promptOptimizationPresets,
        setOptimizationPreset: (preset: PromptOptimizationPreset) =>
          setPromptNodeOptimizationPreset(node.id, preset),
        generationMode,
        isOptimizingPrompt: isPromptOptimizing,
        canOptimizePrompt:
          Boolean(nodePrompt.trim()) && Boolean(codexApiKey.trim()) && !isPromptOptimizing,
        onOptimizePrompt: () => void handleOptimizePrompt(node.id),
      }
    }

    if (type === 'style') {
      return {
        onDeleteNode: deleteWorkflowNode,
        styles: styleOptions,
        categories: styleCategories,
        selectedStyleId: getWorkflowNodeSelectedStyleId(node),
        setSelectedStyleId: (id: string) => setStyleNodeSelection(node.id, id),
        loadCategory: (category: string) => void loadStyleCategory(category),
        isLoadingStyles,
      }
    }

    if (type === 'generate') {
      const promptEdge = edges.find(
        (edge) =>
          edge.target === node.id &&
          edge.targetHandle === 'prompt' &&
          nodes.find((item) => item.id === edge.source)?.type === 'prompt'
      )
      const promptNode =
        (promptEdge ? nodes.find((item) => item.id === promptEdge.source) : null) ||
        nodes.find((item) => item.type === 'prompt') ||
        null
      const canGenerateNode =
        !activeCanvasGenerating &&
        Boolean(apiKey && imageBaseUrl && model && getWorkflowNodePrompt(promptNode).trim())
      const activeSize = selectedGenerationSize() || size
      const workflowSizes = sizes.includes(activeSize) ? sizes : [activeSize, ...sizes]
      const workflowSizeOptions = workflowSizes.map((item) => ({
        value: item,
        label: workflowSizeOptionLabel(item),
      }))

      return {
        onDeleteNode: deleteWorkflowNode,
        model,
        sortedModels,
        setModel,
        size: activeSize,
        sizeOptions: workflowSizeOptions,
        setSize: (nextSize: string) => {
          setSizeMode('preset')
          setSize(nextSize)
        },
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
        canGenerate: canGenerateNode,
        onGenerate: () => void handleGenerate(node.id),
        image: images.find((image) => image.id === getWorkflowNodeLatestImageId(node)) || null,
        outputTitle: getWorkflowNodeOutputTitle(node),
        updateOutputTitle: (title: string) => updateGenerateNodeOutputTitle(node.id, title),
        isOutputTitleDuplicate: isReferenceTitleTaken(
          activeCanvas,
          getWorkflowNodeOutputTitle(node),
          generateOutputOwnerId(node.id)
        ),
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
      edges,
      generationMode,
      referenceImages,
      apiKey,
      imageBaseUrl,
      codexApiKey,
      textBaseUrl,
      textModel,
      optimizingPromptNodeIds,
      styleOptions,
      styleCategories,
      loadStyleCategory,
      isLoadingStyles,
      setStyleNodeSelection,
      model,
      sortedModels,
      size,
      sizeMode,
      customSizeWidth,
      customSizeHeight,
      quality,
      count,
      responseFormat,
      inputFidelity,
      images,
      activeCanvas,
      activeCanvasGenerating,
      deleteWorkflowNode,
      setPromptNodePrompt,
      setPromptNodeOptimizationPreset,
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
              : edge.source.startsWith('style')
                ? '风格 -> 文字描述'
              : edge.source.startsWith('generate')
                ? '生成图 -> 文字描述'
                : '提示词 -> 图片生成'),
          onDelete: deleteWorkflowEdge,
        },
        animated:
          edge.source.includes('prompt') ||
          (activeCanvasGenerating && edge.source.includes('generate')) ||
          edge.source.includes('style') ||
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

      if (source.type === 'style') {
        return (
          target.type === 'prompt' &&
          connection.sourceHandle === 'style' &&
          connection.targetHandle === 'style'
        )
      }

      if (source.type === 'prompt') {
        return (
          target.type === 'generate' &&
          connection.sourceHandle === 'prompt' &&
          connection.targetHandle === 'prompt'
        )
      }

      if (source.type === 'generate') {
        const targetHandle = connection.targetHandle || ''
        return (
          target.type === 'prompt' &&
          connection.sourceHandle === 'generated-image' &&
          PROMPT_REFERENCE_HANDLE_IDS.includes(targetHandle)
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
        sourceType === 'asset'
          ? '参考图 -> 文字描述'
          : sourceType === 'style'
            ? '风格 -> 文字描述'
            : sourceType === 'generate'
              ? '生成图 -> 文字描述'
              : '提示词 -> 图片生成'
      const className =
        sourceType === 'asset'
          ? 'edge-blue'
          : sourceType === 'style'
            ? 'edge-green'
            : sourceType === 'prompt'
              ? 'edge-violet'
              : 'edge-pink'

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
      const menuGap = 6
      const menuWidth = 190
      const menuHeight = 210
      const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
      let menuX = event.clientX + menuGap
      let menuY = event.clientY

      if (viewportWidth && menuX + menuWidth > viewportWidth - menuGap) {
        menuX = Math.max(menuGap, event.clientX - menuWidth - menuGap)
      }

      if (viewportHeight && menuY + menuHeight > viewportHeight - menuGap) {
        menuY = Math.max(menuGap, viewportHeight - menuHeight - menuGap)
      }

      setPaneMenu({
        x: menuX,
        y: menuY,
        position,
      })
    },
    [flowInstance]
  )

  function addWorkflowNodeAt(type: WorkflowNodeType, position: { x: number; y: number }) {
    const id = `${type}-${Date.now()}`
    setNodes((currentNodes) => {
      const data =
        type === 'generate'
            ? {
                outputTitle: createUniqueReferenceTitle(
                  `生成图${currentNodes.filter((node) => node.type === 'generate').length + 1}`,
                  getCanvasReferenceNameEntries({ nodes: currentNodes })
                ),
              }
            : {}

      return [
        ...currentNodes,
        {
          id,
          type,
          position,
          data,
        },
      ]
    })
    setPaneMenu(null)
    setStatus('已创建节点，拖动端口可连线')
  }

  function addWorkflowNode(type: WorkflowNodeType) {
    if (!paneMenu) return
    addWorkflowNodeAt(type, paneMenu.position)
  }

  const activePortalView = currentView === 'workflow' ? 'home' : currentView
  const portalViewMeta: Record<Exclude<AppView, 'workflow'>, { title: string; description: string }> = {
    home: {
      title: '快速生成',
      description: '用提示词和参数快速完成生图，结果自动进入图库管理。',
    },
    advanced: {
      title: '高级生成',
      description: '完整控制生图模型、尺寸、质量、数量和返回参数。',
    },
    commerce: {
      title: '电商主题',
      description: '上传商品白底图和目标风格图，选择主图或详情图后生成。',
    },
    console: {
      title: '控制台',
      description: '管理连接、模型和本地数据导入导出。',
    },
    gallery: {
      title: '图库',
      description: '集中管理本地生成结果，预览、下载和删除都在这里完成。',
    },
  }
  const portalMeta = portalViewMeta[activePortalView]
  const commerceThemeMenu = (
    <div className='sidebar-nav-group ecommerce-nav-group'>
      <button
        type='button'
        className={currentView === 'commerce' ? 'active' : ''}
        onClick={() => enterSidebarView('commerce')}
        aria-label='电商主题'
        title='电商主题'
      >
        <ShoppingBag size={16} />
        电商主题
      </button>
    </div>
  )
  const commerceCanGenerate =
    isConfigured &&
    commerceProductImages.length > 0 &&
    Boolean(commerceStyleImage) &&
    Boolean(effectiveCommerceCategoryPath)
  const isCommerceView = currentView === 'commerce'
  const commerceCopy = commerceGenerateKind === 'detail'
    ? {
        title: '详情图制作',
        styleLabel: '详情风格图',
        styleHint: '上传你喜欢的详情页风格，用于参考版式、分区、背景、光线和文字排版。',
        descriptionLabel: '卖点描述（可选）',
        descriptionPlaceholder: '可简单写商品卖点、详情页短文案或需要替换的文字；留空时会根据详情风格图自动生成提示词',
        action: '生成详情图',
      }
    : {
        title: '主图制作',
        styleLabel: '目标风格图',
        styleHint: '上传你喜欢的主图风格，用于参考光线、背景和构图。',
        descriptionLabel: '文字描述（可选）',
        descriptionPlaceholder: '可简单写卖点、文案或替换文字；留空时会根据目标风格图自动生成主图提示词',
        action: '生成主图',
      }
  const renderCommerceKindField = () => (
    <div className='commerce-kind-field' aria-label='生成类型'>
      <div className='commerce-kind-copy'>
        <strong>生成类型</strong>
        <span>同一套素材和品类信息，在生成前选择主图或详情图</span>
      </div>
      <div className='commerce-kind-toggle' role='group' aria-label='选择生成类型'>
        <button
          type='button'
          className={commerceGenerateKind === 'main' ? 'active' : ''}
          onClick={() => setCommerceGenerateKind('main')}
          aria-pressed={commerceGenerateKind === 'main'}
        >
          <ImageIcon size={15} />
          主图
        </button>
        <button
          type='button'
          className={commerceGenerateKind === 'detail' ? 'active' : ''}
          onClick={() => setCommerceGenerateKind('detail')}
          aria-pressed={commerceGenerateKind === 'detail'}
        >
          <Layers size={15} />
          详情图
        </button>
      </div>
    </div>
  )
  const renderCommerceCategoryField = () => (
    <div className='commerce-category-field' aria-label='商品品类'>
      <div className='commerce-category-heading'>
        <strong>商品品类</strong>
        <span>预设类目和自定义类目二选一，生成时会作为提示词强约束</span>
      </div>
      <div className='commerce-category-mode' role='group' aria-label='选择类目来源'>
        <button
          type='button'
          className={commerceCategoryMode === 'preset' ? 'active' : ''}
          onClick={() => {
            setCommerceCategoryMode('preset')
            setCommerceCustomCategory('')
          }}
          aria-pressed={commerceCategoryMode === 'preset'}
        >
          预设类目
        </button>
        <button
          type='button'
          className={commerceCategoryMode === 'custom' ? 'active' : ''}
          onClick={() => {
            setCommerceCategoryMode('custom')
            setCommerceCategoryLevel1('')
            setCommerceCategoryLevel2('')
            setCommerceCategoryLevel3('')
          }}
          aria-pressed={commerceCategoryMode === 'custom'}
        >
          自定义类目
        </button>
      </div>
      <div className='commerce-category-grid'>
        <label className='field'>
          <span>一级类目</span>
          <select
            value={commerceCategoryLevel1}
            disabled={commerceCategoryMode === 'custom'}
            onChange={(event) => {
              setCommerceCategoryLevel1(event.target.value)
              setCommerceCategoryLevel2('')
              setCommerceCategoryLevel3('')
            }}
          >
            <option value=''>选择一级类目</option>
            {commerceCategoryTree.map((category) => (
              <option key={category.name} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className='field'>
          <span>二级类目</span>
          <select
            value={commerceCategoryLevel2}
            disabled={commerceCategoryMode === 'custom' || !commerceCategoryLevel1}
            onChange={(event) => {
              setCommerceCategoryLevel2(event.target.value)
              setCommerceCategoryLevel3('')
            }}
          >
            <option value=''>选择二级类目</option>
            {commerceCategoryLevel2Options.map((category) => (
              <option key={category.name} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className='field'>
          <span>三级类目</span>
          <select
            value={commerceCategoryLevel3}
            disabled={commerceCategoryMode === 'custom' || !commerceCategoryLevel2}
            onChange={(event) => setCommerceCategoryLevel3(event.target.value)}
          >
            <option value=''>选择三级类目</option>
            {commerceCategoryLevel3Options.map((category) => (
              <option key={category.name} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className='field commerce-custom-category'>
        <span>自定义类目</span>
        <input
          value={commerceCustomCategory}
          disabled={commerceCategoryMode === 'preset'}
          onChange={(event) => setCommerceCustomCategory(event.target.value)}
          placeholder='例如：食品饮料 / 地方特产 / 手工锅巴，或直接写“户外露营咖啡器具”'
        />
      </label>
    </div>
  )
  const renderCommerceUpload = (
    kind: 'product' | 'style',
    label: string,
    hint: string,
    images: ReferenceImage[]
  ) => (
    <div className={`commerce-upload ${images.length > 0 ? 'filled' : ''}`}>
      <div className='commerce-upload-copy'>
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      {images.length > 0 ? (
        <div className='commerce-upload-preview-list'>
          {images.map((image, index) => (
            <div className='commerce-upload-preview' key={image.id}>
              <img src={image.dataUrl} alt={kind === 'product' ? `${label} ${index + 1}` : label} />
              <div>
                <strong>{image.name}</strong>
                <span>{kind === 'product' ? `角度 ${index + 1} · ` : ''}{image.type || '图片文件'}</span>
              </div>
              <button
                type='button'
                className='ghost'
                onClick={() => {
                  if (kind === 'product') {
                    setCommerceProductImages((current) =>
                      current
                        .filter((item) => item.id !== image.id)
                        .map((item, itemIndex) => ({
                          ...item,
                          title: `商品白底图 ${itemIndex + 1}`,
                        }))
                    )
                  } else {
                    setCommerceStyleImage(null)
                  }
                }}
                aria-label={`移除${kind === 'product' ? `${label} ${index + 1}` : label}`}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <label
        className={`secondary commerce-file-action ${
          kind === 'product' && images.length >= MAX_COMMERCE_PRODUCT_IMAGES ? 'disabled' : ''
        }`}
        aria-disabled={kind === 'product' && images.length >= MAX_COMMERCE_PRODUCT_IMAGES}
      >
        <Upload size={15} />
        {kind === 'product'
          ? images.length >= MAX_COMMERCE_PRODUCT_IMAGES
            ? `已达上限（${MAX_COMMERCE_PRODUCT_IMAGES}/${MAX_COMMERCE_PRODUCT_IMAGES}）`
            : images.length > 0
            ? `继续上传（${images.length}/${MAX_COMMERCE_PRODUCT_IMAGES}）`
            : `上传图片（最多 ${MAX_COMMERCE_PRODUCT_IMAGES} 张）`
          : images.length > 0
            ? '替换图片'
            : '上传图片'}
        <input
          type='file'
          accept='image/*'
          multiple={kind === 'product'}
          disabled={kind === 'product' && images.length >= MAX_COMMERCE_PRODUCT_IMAGES}
          onChange={(event) => {
            void handleCommerceImageFiles(kind, event.target.files)
            event.target.value = ''
          }}
        />
      </label>
    </div>
  )
  const isGalleryReferencePickerOpen = Boolean(galleryReferencePickerNodeId)
  const closeGalleryReferencePicker = () => {
    if (selectingGalleryReferenceImageId) return
    setGalleryReferencePickerNodeId('')
  }

  return (
    <div className='app-shell portal-shell' data-theme={resolvedTheme}>
      {notice ? (
        <div className='app-notice' role='status' aria-live='polite'>
          <KeyRound size={16} aria-hidden='true' />
          <div>
            <strong>需要先完成连接配置</strong>
            <span>{notice.message}</span>
          </div>
          <button type='button' onClick={() => setNotice(null)} aria-label='关闭配置提示'>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {currentView === 'workflow' ? (
        <main className='portal-stage app-workspace-shell'>
          <aside
            className={`app-sidebar ${isSidebarDrawerOpen ? 'drawer-open' : ''}`}
            aria-label='主工具栏'
          >
            <button
              type='button'
              className='sidebar-drawer-toggle'
              onClick={() => setIsSidebarDrawerOpen((current) => !current)}
              aria-label={isSidebarDrawerOpen ? '收起主工具栏' : '展开主工具栏'}
              aria-controls='app-sidebar-nav'
              aria-expanded={isSidebarDrawerOpen}
              title={isSidebarDrawerOpen ? '收起' : '展开'}
            >
              {isSidebarDrawerOpen ? <X size={17} /> : <Menu size={17} />}
            </button>
            <button type='button' className='portal-brand app-sidebar-brand' onClick={() => enterSidebarView('home')}>
              <span className='brand-mark'>
                <Sparkles size={21} />
              </span>
              <span>
                <strong>GPT Image Tools</strong>
                <small>{isConfigured ? `已配置 ${model}` : '先完成控制台配置'}</small>
              </span>
            </button>
            <nav id='app-sidebar-nav' className='portal-nav app-sidebar-nav' aria-label='主导航'>
              <button
                type='button'
                onClick={() => enterSidebarView('home')}
              >
                <Home size={16} />
                快速生成
              </button>
              <button
                type='button'
                onClick={() => enterSidebarView('advanced')}
              >
                <SlidersHorizontal size={16} />
                高级生成
              </button>
              {commerceThemeMenu}
              <button
                type='button'
                className='active'
                onClick={() => enterSidebarView('workflow')}
              >
                <Workflow size={16} />
                工作流
              </button>
              <button
                type='button'
                onClick={() => enterSidebarView('gallery')}
              >
                <Layers size={16} />
                图库
              </button>
              <button
                type='button'
                onClick={() => enterSidebarView('console')}
              >
                <Terminal size={16} />
                控制台
              </button>
            </nav>
            <div className='app-sidebar-footer'>
              <div className='sidebar-theme-switcher' aria-label='主题切换'>
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
                    </button>
                  )
                })}
              </div>
              <a
                className='sidebar-github-link'
                href={GITHUB_REPO_URL}
                target='_blank'
                rel='noreferrer'
                aria-label='打开 GitHub 开源仓库'
                title='GitHub'
              >
                <Github size={16} />
                <ExternalLink size={12} />
              </a>
            </div>
          </aside>
          <button
            type='button'
            className={`sidebar-scrim ${isSidebarDrawerOpen ? 'visible' : ''}`}
            onClick={() => setIsSidebarDrawerOpen(false)}
            aria-label='关闭主工具栏'
          />

          <section className='app-workspace workflow-workspace'>
          <main className='workflow-stage'>
          <aside
            className={`canvas-drawer workflow-canvas-panel ${isCanvasDrawerOpen ? 'drawer-open' : 'drawer-collapsed'}`}
            aria-label='画布列表'
          >
            <button
              type='button'
              className='workflow-canvas-drawer-toggle'
              onClick={() => {
                hasManuallyToggledCanvasDrawerRef.current = true
                setIsCanvasDrawerOpen((current) => !current)
              }}
              aria-expanded={isCanvasDrawerOpen}
              title={isCanvasDrawerOpen ? '收起画布' : '展开画布'}
            >
              {isCanvasDrawerOpen ? <X size={17} /> : <Layers size={17} />}
              <span>画布</span>
            </button>
            <div className='workflow-canvas-drawer-content'>
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

              <div className='canvas-list'>
                {canvases.map((canvas) => {
                  const isRenamingCanvas = canvas.id === renamingCanvasId

                  return (
                    <article
                      key={canvas.id}
                      className={`canvas-item ${canvas.id === activeCanvas?.id ? 'active' : ''}`}
                    >
                      {isRenamingCanvas ? (
                        <div className='canvas-switch canvas-switch-editing'>
                          <label className='canvas-name-field'>
                            <span>画布名称</span>
                            <input
                              ref={canvasListRenameInputRef}
                              value={renamingCanvasName}
                              onChange={(event) => setRenamingCanvasName(event.target.value.slice(0, 32))}
                              onKeyDown={(event) => handleCanvasRenameShortcut(event, canvas.id)}
                              aria-label={`输入 ${canvas.name || '画布'} 的新名称`}
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
                      ) : (
                        <button
                          type='button'
                          className='canvas-switch'
                          onClick={() => {
                            setActiveCanvasId(canvas.id)
                            setPaneMenu(null)
                            setStatus(`已切换到 ${canvas.name}`)
                          }}
                          aria-label={`打开 ${canvas.name || '未命名画布'}`}
                        >
                          <span className='canvas-name-text'>{canvas.name || '未命名画布'}</span>
                          <span className='canvas-switch-meta'>
                            <span>
                            {canvas.nodes.length} 节点 · {canvas.edges.length} 连接
                            </span>
                            {isCanvasGenerating(canvas) ? (
                              <span className='canvas-generation-state'>
                                <Loader2 className='spin' size={12} />
                                生成中
                              </span>
                            ) : null}
                          </span>
                        </button>
                      )}
                      <div className='canvas-actions'>
                        <button
                          type='button'
                          onClick={() =>
                            isRenamingCanvas
                              ? handleCommitCanvasRename(canvas.id)
                              : handleBeginCanvasRename(canvas)
                          }
                          aria-label={isRenamingCanvas ? `完成重命名 ${canvas.name}` : `重命名 ${canvas.name}`}
                          title={isRenamingCanvas ? '完成重命名' : '重命名画布'}
                        >
                          {isRenamingCanvas ? <Check size={14} /> : <Edit3 size={14} />}
                        </button>
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
                  )
                })}
              </div>
            </div>
          </aside>
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
            <button type='button' onClick={() => addWorkflowNode('style')}>
              标签节点 · 选择风格
            </button>
            <button type='button' onClick={() => addWorkflowNode('generate')}>
              工作节点 · 图片生成
            </button>
          </div>
        ) : null}

        {error ? (
          <div className='error-toast' role='alert'>
            <strong>执行失败</strong>
            <span>{error}</span>
            <button type='button' onClick={() => setError('')} aria-label='关闭错误提示'>
              <X size={15} />
            </button>
          </div>
        ) : null}
        {!error && generationSuccess ? (
          <div className='error-toast success-toast' role='status' aria-live='polite'>
            <Check size={16} aria-hidden='true' />
            <strong>{generationSuccess.title}</strong>
            <span>{generationSuccess.message}</span>
            <button
              type='button'
              className='toast-action'
              onClick={() => {
                setGenerationSuccess(null)
                enterSidebarView('gallery')
              }}
            >
              去图库查看
            </button>
          </div>
        ) : null}

          </main>
          </section>
        </main>
      ) : (
        <main className='portal-stage app-workspace-shell'>
          <aside
            className={`app-sidebar ${isSidebarDrawerOpen ? 'drawer-open' : ''}`}
            aria-label='主工具栏'
          >
            <button
              type='button'
              className='sidebar-drawer-toggle'
              onClick={() => setIsSidebarDrawerOpen((current) => !current)}
              aria-label={isSidebarDrawerOpen ? '收起主工具栏' : '展开主工具栏'}
              aria-controls='app-sidebar-nav'
              aria-expanded={isSidebarDrawerOpen}
              title={isSidebarDrawerOpen ? '收起' : '展开'}
            >
              {isSidebarDrawerOpen ? <X size={17} /> : <Menu size={17} />}
            </button>
            <button type='button' className='portal-brand app-sidebar-brand' onClick={() => enterSidebarView('home')}>
              <span className='brand-mark'>
                <Sparkles size={21} />
              </span>
              <span>
                <strong>GPT Image Tools</strong>
                <small>{isConfigured ? `已配置 ${model}` : '先完成控制台配置'}</small>
              </span>
            </button>
            <nav id='app-sidebar-nav' className='portal-nav app-sidebar-nav' aria-label='主导航'>
              <button
                type='button'
                className={currentView === 'home' ? 'active' : ''}
                onClick={() => enterSidebarView('home')}
              >
                <Home size={16} />
                快速生成
              </button>
              <button
                type='button'
                className={currentView === 'advanced' ? 'active' : ''}
                onClick={() => enterSidebarView('advanced')}
              >
                <SlidersHorizontal size={16} />
                高级生成
              </button>
              {commerceThemeMenu}
              <button
                type='button'
                onClick={() => enterSidebarView('workflow')}
              >
                <Workflow size={16} />
                工作流
              </button>
              <button
                type='button'
                className={currentView === 'gallery' ? 'active' : ''}
                onClick={() => enterSidebarView('gallery')}
              >
                <Layers size={16} />
                图库
              </button>
              <button
                type='button'
                className={currentView === 'console' ? 'active' : ''}
                onClick={() => enterSidebarView('console')}
              >
                <Terminal size={16} />
                控制台
              </button>
            </nav>
            <div className='app-sidebar-footer'>
              <div className='sidebar-theme-switcher' aria-label='主题切换'>
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
                    </button>
                  )
                })}
              </div>
              <a
                className='sidebar-github-link'
                href={GITHUB_REPO_URL}
                target='_blank'
                rel='noreferrer'
                aria-label='打开 GitHub 开源仓库'
                title='GitHub'
              >
                <Github size={16} />
                <ExternalLink size={12} />
              </a>
            </div>
          </aside>
          <button
            type='button'
            className={`sidebar-scrim ${isSidebarDrawerOpen ? 'visible' : ''}`}
            onClick={() => setIsSidebarDrawerOpen(false)}
            aria-label='关闭主工具栏'
          />

          <section className={`app-workspace ${currentView === 'gallery' ? 'gallery-workspace' : ''}`}>
            {currentView !== 'gallery' ? (
              <header className='workspace-topbar'>
                <div className='workspace-title'>
                  <h1>{portalMeta.title}</h1>
                  <p>{portalMeta.description}</p>
                </div>
              </header>
            ) : null}

          {currentView === 'home' ? (
            <section className='launchpad'>
              <div className='workbench-grid'>
                <section className='portal-panel workbench-composer'>
                  <div className='section-title'>
                    <ImageIcon size={16} />
                    <span>快速生成</span>
                  </div>
                  <label className='field'>
                    <span>图片描述</span>
                    <textarea
                      className='simple-prompt'
                      value={simplePrompt}
                      onChange={(event) => setSimplePrompt(event.target.value)}
                      placeholder='例如：一张高级科技产品海报，干净背景，清晰主视觉，真实材质，高级棚拍光线'
                    />
                  </label>
                  <div className='simple-param-grid'>
                    <label className='field'>
                      <span>模型</span>
                      <select value={model} onChange={(event) => setModel(event.target.value)}>
                        {sortedModels.length === 0 ? (
                          <option value={model}>{model}</option>
                        ) : (
                          sortedModels.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.id}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                    {renderSizeField()}
                    <label className='field'>
                      <span>质量</span>
                      <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                        {qualities.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className='field'>
                      <span>数量</span>
                      <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                        {counts.map((item) => (
                          <option key={item} value={item}>
                            {item}x
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className='simple-actions'>
                    <button
                      type='button'
                      className='secondary simple-optimize-action'
                      onClick={() => void handleOptimizeSimplePrompt()}
                      disabled={isOptimizingSimplePrompt || !simplePrompt.trim()}
                    >
                      {isOptimizingSimplePrompt ? (
                        <Loader2 className='spin' size={16} />
                      ) : (
                        <Edit3 size={16} />
                      )}
                      {isOptimizingSimplePrompt ? '优化中' : '优化提示词'}
                    </button>
                    <button
                      type='button'
                      className='primary-action'
                      onClick={() => void handleSimpleGenerate()}
                      disabled={isQuickGenerating || !isConfigured || !simplePrompt.trim()}
                    >
                      {isQuickGenerating ? <Loader2 className='spin' size={16} /> : <Sparkles size={16} />}
                      {isConfigured ? (isQuickGenerating ? '生成中' : '立即生成') : '先完成配置'}
                    </button>
                  </div>
                </section>

              </div>

            </section>
          ) : null}

          {currentView === 'advanced' ? (
            <section className='advanced-page'>
              <section className='portal-panel advanced-composer'>
                <div className='section-title'>
                  <SlidersHorizontal size={16} />
                  <span>高级生成</span>
                </div>
                <div className='field'>
                  <div className='field-label-row'>
                    <label htmlFor='advanced-prompt'>图片描述</label>
                    <button
                      type='button'
                      className='secondary simple-optimize-action compact-action'
                      onClick={() => void handleOptimizeSimplePrompt('advanced')}
                      disabled={isOptimizingSimplePrompt || !advancedPrompt.trim()}
                    >
                      {isOptimizingSimplePrompt ? (
                        <Loader2 className='spin' size={16} />
                      ) : (
                        <Edit3 size={16} />
                      )}
                      {isOptimizingSimplePrompt ? '优化中' : '优化提示词'}
                    </button>
                  </div>
                  <textarea
                    id='advanced-prompt'
                    className='simple-prompt advanced-prompt'
                    value={advancedPrompt}
                    onChange={(event) => setAdvancedPrompt(event.target.value)}
                    placeholder='例如：一张高级科技产品海报，干净背景，清晰主视觉，真实材质，高级棚拍光线'
                  />
                </div>
                <div className='field advanced-negative-field'>
                  <div className='field-label-row'>
                    <span>负面提示词</span>
                    <button
                      type='button'
                      className='secondary compact-action'
                      onClick={() => void handleOptimizeAdvancedNegativePrompt()}
                      disabled={
                        isOptimizingNegativePrompt || !advancedPrompt.trim()
                      }
                    >
                      {isOptimizingNegativePrompt ? (
                        <Loader2 className='spin' size={15} />
                      ) : null}
                      {isOptimizingNegativePrompt ? '优化中' : '优化负面提示词'}
                    </button>
                  </div>
                  <textarea
                    className='advanced-negative-prompt'
                    value={advancedNegativePrompt}
                    onChange={(event) => setAdvancedNegativePrompt(event.target.value)}
                    placeholder='例如：文字、水印、低清、畸形、错手、脏背景'
                  />
                </div>
                <section className='advanced-sketch-board' aria-label='分镜草图画布'>
                  <div className='advanced-sketch-header'>
                    <div>
                      <strong>分镜草图</strong>
                      <span>手绘主体、元素和留白位置；生成时会先用文本模型识别并写入最终提示词。</span>
                    </div>
                    <button
                      type='button'
                      className='secondary'
                      onClick={handleClearAdvancedSketch}
                      disabled={!isAdvancedSketchDirty && !advancedSketchDescription}
                    >
                      <Trash2 size={15} />
                      清空草图
                    </button>
                  </div>
                  <canvas
                    ref={advancedSketchCanvasRef}
                    className='advanced-sketch-canvas'
                    width={ADVANCED_SKETCH_WIDTH}
                    height={ADVANCED_SKETCH_HEIGHT}
                    onPointerDown={handleAdvancedSketchPointerDown}
                    onPointerMove={handleAdvancedSketchPointerMove}
                    onPointerUp={stopAdvancedSketchDrawing}
                    onPointerCancel={stopAdvancedSketchDrawing}
                    aria-label='手绘分镜草图'
                  />
                  {advancedSketchDescription ? (
                    <div className='advanced-sketch-result'>
                      <strong>草图识别结果</strong>
                      <p>{advancedSketchDescription}</p>
                    </div>
                  ) : null}
                </section>
                <section className='advanced-style-board' aria-label='高级生成风格库'>
                  <div className='advanced-style-controls'>
                    <label className='field'>
                      <span>风格分类</span>
                      <select
                        value={advancedStyleCategory}
                        disabled={isLoadingStyles || styleCategories.length === 0}
                        onChange={(event) => {
                          const nextCategory = event.target.value
                          setAdvancedStyleCategory(nextCategory)
                          setAdvancedSelectedStyleId('')
                          if (nextCategory) void loadStyleCategory(nextCategory)
                        }}
                      >
                        <option value=''>选择分类</option>
                        {styleCategories.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name} · {item.count}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className='field'>
                      <span>风格</span>
                      <select
                        value={advancedSelectedStyleId}
                        disabled={isLoadingStyles || advancedVisibleStyles.length === 0}
                        onChange={(event) => setAdvancedSelectedStyleId(event.target.value)}
                      >
                        <option value=''>不使用风格</option>
                        {advancedVisibleStyles.map((style) => (
                          <option key={style.id} value={style.id}>
                            {style.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className='advanced-style-preview'>
                    <div className='advanced-style-image-frame'>
                      {advancedSelectedStyle?.previewUrl ? (
                        <img
                          src={advancedSelectedStyle.previewUrl}
                          alt={`${advancedSelectedStyle.name} 风格示例`}
                          loading='lazy'
                        />
                      ) : (
                        <div>
                          {isLoadingStyles ? <Loader2 className='spin' size={28} /> : <ImageIcon size={30} />}
                          <span>{isLoadingStyles ? 'LOADING' : 'NO STYLE'}</span>
                        </div>
                      )}
                    </div>
                    <div className='advanced-style-meta'>
                      <strong>
                        {advancedSelectedStyle
                          ? `${advancedSelectedStyle.category} / ${advancedSelectedStyle.name}`
                          : '选择一个风格后，会把对应 JSON 协议加入最终提示词'}
                      </strong>
                      {advancedStyleKeywords.length > 0 ? (
                        <div className='advanced-style-keywords'>
                          {advancedStyleKeywords.map((keyword) => (
                            <span key={keyword}>{keyword}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>
                <div className='advanced-param-grid'>
                  <label className='field'>
                    <span>模型</span>
                    <select
                      value={advancedModel}
                      onChange={(event) => setAdvancedModel(event.target.value)}
                    >
                      {sortedModels.length === 0 ? (
                        <option value={advancedModel}>{advancedModel}</option>
                      ) : (
                        sortedModels.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.id}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  {renderSizeField({
                    size: advancedSize,
                    sizeMode: advancedSizeMode,
                    customSizeWidth: advancedCustomSizeWidth,
                    customSizeHeight: advancedCustomSizeHeight,
                    setSize: setAdvancedSize,
                    setSizeMode: setAdvancedSizeMode,
                    setCustomSizeWidth: setAdvancedCustomSizeWidth,
                    setCustomSizeHeight: setAdvancedCustomSizeHeight,
                  })}
                  <label className='field'>
                    <span>质量</span>
                    <select
                      value={advancedQuality}
                      onChange={(event) => setAdvancedQuality(event.target.value)}
                    >
                      {qualities.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>背景</span>
                    <select
                      value={advancedBackground}
                      onChange={(event) => setAdvancedBackground(event.target.value as AdvancedBackground)}
                    >
                      {backgroundOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>数量</span>
                    <select
                      value={advancedCount}
                      onChange={(event) => setAdvancedCount(Number(event.target.value))}
                    >
                      {counts.map((item) => (
                        <option key={item} value={item}>
                          {item}x
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>返回格式</span>
                    <select
                      value={advancedResponseFormat}
                      onChange={(event) =>
                        setAdvancedResponseFormat(event.target.value as 'url' | 'b64_json')
                      }
                    >
                      <option value='b64_json'>b64_json</option>
                      <option value='url'>url</option>
                    </select>
                  </label>
                  <label className='field'>
                    <span>输入保真度</span>
                    <select
                      value={advancedInputFidelity}
                      onChange={(event) =>
                        setAdvancedInputFidelity(event.target.value as 'low' | 'high')
                      }
                    >
                      <option value='high'>high</option>
                      <option value='low'>low</option>
                    </select>
                  </label>
                  <label className='field'>
                    <span>创意强度</span>
                    <select
                      value={advancedCreativity}
                      onChange={(event) => setAdvancedCreativity(event.target.value as AdvancedCreativity)}
                    >
                      {creativityOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>风格权重</span>
                    <select
                      value={advancedStyleWeight}
                      onChange={(event) => setAdvancedStyleWeight(event.target.value as AdvancedStyleWeight)}
                    >
                      {styleWeightOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>草图权重</span>
                    <select
                      value={advancedSketchWeight}
                      onChange={(event) => {
                        setAdvancedSketchWeight(event.target.value as AdvancedSketchWeight)
                        setAdvancedSketchDescription('')
                      }}
                    >
                      {sketchWeightOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>提示词优化方向</span>
                    <select
                      value={advancedPromptOptimizationPreset}
                      onChange={(event) =>
                        setAdvancedPromptOptimizationPreset(event.target.value as PromptOptimizationPreset)
                      }
                    >
                      {promptOptimizationPresets.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className='simple-actions'>
                  <button
                    type='button'
                    className='primary-action'
                    onClick={() =>
                      void handleSimpleGenerate({
                        includeAdvancedSketch: true,
                        includeAdvancedStyle: true,
                      })
                    }
                    disabled={
                      isAdvancedGenerating ||
                      isAnalyzingAdvancedSketch ||
                      !isConfigured ||
                      !advancedPrompt.trim()
                    }
                  >
                    {isAdvancedGenerating || isAnalyzingAdvancedSketch ? (
                      <Loader2 className='spin' size={16} />
                    ) : (
                      <Sparkles size={16} />
                    )}
                    {isConfigured
                      ? isAnalyzingAdvancedSketch
                        ? '识别草图'
                        : isAdvancedGenerating
                          ? '生成中'
                          : '立即生成'
                      : '先完成配置'}
                  </button>
                </div>
              </section>
            </section>
          ) : null}

          {isCommerceView ? (
            <section className='commerce-page'>
              <section className='portal-panel commerce-composer'>
                <div className='section-title'>
                  <ShoppingBag size={16} />
                  <span>电商主题</span>
                </div>
                {renderCommerceKindField()}
                <div className='commerce-upload-grid'>
                  {renderCommerceUpload(
                    'product',
                    '商品白底图',
                    `上传同一个商品的白底图，可包含多个角度，最多 ${MAX_COMMERCE_PRODUCT_IMAGES} 张。`,
                    commerceProductImages
                  )}
                  {renderCommerceUpload(
                    'style',
                    commerceCopy.styleLabel,
                    commerceCopy.styleHint,
                    commerceStyleImage ? [commerceStyleImage] : []
                  )}
                </div>
                {renderCommerceCategoryField()}
                <label className='field'>
                  <span>{commerceCopy.descriptionLabel}</span>
                  <textarea
                    className='commerce-description'
                    value={commerceDescription}
                    onChange={(event) => setCommerceDescription(event.target.value)}
                    placeholder={commerceCopy.descriptionPlaceholder}
                  />
                </label>
                <div className='simple-param-grid commerce-param-grid'>
                  <label className='field'>
                    <span>模型</span>
                    <select value={model} onChange={(event) => setModel(event.target.value)}>
                      {sortedModels.length === 0 ? (
                        <option value={model}>{model}</option>
                      ) : (
                        sortedModels.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.id}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  {renderSizeField()}
                  <label className='field'>
                    <span>质量</span>
                    <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                      {qualities.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className='field'>
                    <span>数量</span>
                    <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                      {counts.map((item) => (
                        <option key={item} value={item}>
                          {item}x
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className='simple-actions'>
                  <button
                    type='button'
                    className='primary-action'
                    onClick={() => void handleCommerceGenerate(commerceGenerateKind)}
                    disabled={isCommerceGenerating || !commerceCanGenerate}
                  >
                    {isCommerceGenerating ? <Loader2 className='spin' size={16} /> : <Sparkles size={16} />}
                    {isConfigured ? (isCommerceGenerating ? '生成中' : commerceCopy.action) : '先完成配置'}
                  </button>
                </div>
              </section>

            </section>
          ) : null}

          {currentView === 'gallery' ? (
            <section className='gallery-page'>
              <section className='gallery-page-panel'>
                <div className='gallery-hero'>
                  <div className='gallery-hero-copy'>
                    <h2>本地图库</h2>
                    <p>把刚生成的作品铺成灵感墙，快速预览、下载和删除，集中整理本地生成结果。</p>
                  </div>
                  <div className='gallery-hero-stats' aria-label='图库统计'>
                    <div>
                      <strong>{images.length}</strong>
                      <span>张图片</span>
                    </div>
                    <div>
                      <strong>{images.length === 0 ? '暂无' : images[0]?.mode === 'image' ? '图生图' : '文生图'}</strong>
                      <span>最近类型</span>
                    </div>
                  </div>
                </div>
                {images.length === 0 ? (
                  <div className='gallery-empty gallery-page-empty'>
                    <span>生成结果会出现在这里。</span>
                    <button
                      type='button'
                      className='secondary'
                      onClick={() => enterConfiguredView('home')}
                    >
                      <Home size={16} />
                      回到快速生成
                    </button>
                  </div>
                ) : (
                  <GalleryStrip
                    images={images}
                    limit={images.length}
                    onPreview={setPreviewImage}
                    onDownload={handleDownloadImage}
                    onDelete={(id) => void handleDeleteImage(id)}
                  />
                )}
              </section>
            </section>
          ) : null}

          {currentView === 'console' ? (
            <section className='console-page'>
              <div className='console-layout'>
                <section className='portal-panel'>
                  <div className='section-title'>
                    <KeyRound size={16} />
                    <span>连接配置</span>
                  </div>
                  <div className='connection-config-block'>
                    <div className='connection-config-title'>
                      <Sparkles size={14} />
                      <span>文本模型</span>
                      <small>用于优化提示词</small>
                    </div>
                    <label className='field'>
                      <span>文本模型 Base URL</span>
                      <input
                        value={textBaseUrl}
                        onChange={(event) => setTextBaseUrl(event.target.value)}
                        placeholder='https://hotapi.top'
                        spellCheck={false}
                      />
                    </label>
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
                      <span>生图模型 Base URL</span>
                      <input
                        value={imageBaseUrl}
                        onChange={(event) => setImageBaseUrl(event.target.value)}
                        placeholder='https://hotapi.top'
                        spellCheck={false}
                      />
                    </label>
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
                    <label className='field'>
                      <span>上游失败重试次数</span>
                      <input
                        value={imageRetryCount}
                        onChange={(event) =>
                          setImageRetryCount(normalizeImageRetryCount(event.target.value))
                        }
                        type='number'
                        min={0}
                        max={5}
                        step={1}
                      />
                    </label>
                  </div>
                  <label className='checkbox-row'>
                    <input
                      type='checkbox'
                      checked={persistApiKey}
                      onChange={(event) => setPersistApiKey(event.target.checked)}
                    />
                    <span>将 API Key 保存到当前浏览器</span>
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
                    <button
                      className='secondary danger destructive-button'
                      onClick={() => void handleResetConnectionSettings()}
                      aria-label='重设连接配置并清除 API Key'
                      title='重设连接配置并清除 API Key'
                    >
                      <Trash2 size={16} />
                      重设连接
                    </button>
                    <button className='secondary' onClick={handleSaveSettings}>
                      <Save size={16} />
                      保存设置
                    </button>
                    <button
                      className='secondary'
                      onClick={handleFetchModels}
                      disabled={isLoadingModels || !imageBaseUrl || !apiKey}
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

                  <section className='portal-panel compact-panel'>
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
                      图片和设置保存在当前浏览器 IndexedDB。生成和提示词请求从当前浏览器直接发送到上游接口；备份文件不包含 API Key。
                    </p>
                  </section>
              </div>
            </section>
          ) : null}

          {error ? (
            <div className='error-toast portal-error' role='alert'>
              <strong>执行失败</strong>
              <span>{error}</span>
              <button type='button' onClick={() => setError('')} aria-label='关闭错误提示'>
                <X size={15} />
              </button>
            </div>
          ) : null}
          {!error && generationSuccess ? (
            <div className='error-toast portal-error success-toast' role='status' aria-live='polite'>
              <Check size={16} aria-hidden='true' />
              <strong>{generationSuccess.title}</strong>
              <span>{generationSuccess.message}</span>
              <button
                type='button'
                className='toast-action'
                onClick={() => {
                  setGenerationSuccess(null)
                  enterSidebarView('gallery')
                }}
              >
                去图库查看
              </button>
            </div>
          ) : null}
          </section>
        </main>
      )}

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

      {isGalleryReferencePickerOpen ? (
        <div
          className='modal-overlay gallery-reference-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='从图库选择参考图'
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeGalleryReferencePicker()
          }}
        >
          <div className='gallery-reference-dialog'>
            <div className='dialog-header'>
              <div>
                <strong>从图库选择参考图</strong>
                <span>选中的图片会替换当前参考图节点中的图片，并可继续编辑 @标题。</span>
              </div>
              <button
                className='icon-button'
                onClick={closeGalleryReferencePicker}
                aria-label='关闭图库选择'
                disabled={Boolean(selectingGalleryReferenceImageId)}
              >
                <X size={18} />
              </button>
            </div>
            {images.length === 0 ? (
              <div className='gallery-reference-empty'>
                <ImageIcon size={34} />
                <strong>图库暂无图片</strong>
                <span>生成图片后，可以在这里选择为工作流参考图。</span>
              </div>
            ) : (
              <div className='gallery-reference-grid'>
                {images.map((image) => (
                  <button
                    key={image.id}
                    type='button'
                    className='gallery-reference-option'
                    onClick={() =>
                      void selectGalleryReferenceImage(
                        galleryReferencePickerNodeId,
                        image
                      )
                    }
                    disabled={Boolean(selectingGalleryReferenceImageId)}
                    aria-label='选择这张图库图片作为参考图'
                  >
                    <img src={image.src} alt={image.revisedPrompt || image.prompt} />
                    <span>
                      <strong>{image.mode === 'image' ? '图片引导' : '文生图'}</strong>
                      <small>{new Date(image.createdAt).toLocaleString()}</small>
                    </span>
                    {selectingGalleryReferenceImageId === image.id ? (
                      <Loader2 className='spin' size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
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
            <div className='preview-caption'>
              <p>{previewImage.revisedPrompt || previewImage.prompt}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
