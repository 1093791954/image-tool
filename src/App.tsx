import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  ExternalLink,
  KeyRound,
  Layers,
  Loader2,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Save,
  ShoppingBag,
  Sparkles,
  Sun,
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
  type AssetNodeData,
  type BlueprintEdgeData,
  type GenerateNodeData,
  type PromptNodeData,
} from './workflowNodes'
import type { LocalImageRecord, ModelOption, ReferenceImage, ThemeMode } from './types'

const DEFAULT_BASE_URL = 'https://cc.api-corp.top'
const DEFAULT_MODEL = 'gpt-image-2'
const SHOP_URL = 'https://pay.ldxp.cn/shop/LY6AR08H'

const sizes = ['1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024']
const qualities = ['auto', 'standard', 'hd', 'low', 'medium', 'high']
const counts = [1, 2, 3, 4]
const inputFidelities = ['low', 'high'] as const
const themeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
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
  generationMode: 'text' | 'image'
  referenceImages: ReferenceImage[]
  latestImageId?: string
}

type StateUpdater<T> = T | ((current: T) => T)

const WORKFLOW_CANVASES_STORAGE_KEY = 'gpt-image-tools.workflow-canvases.v1'
const ACTIVE_CANVAS_STORAGE_KEY = 'gpt-image-tools.active-canvas.v1'

const initialWorkflowNodes: WorkflowNode[] = [
  { id: 'asset-1', type: 'asset', position: { x: -520, y: -130 }, data: {} },
  { id: 'prompt-1', type: 'prompt', position: { x: -520, y: 255 }, data: {} },
  { id: 'generate-1', type: 'generate', position: { x: 25, y: 45 }, data: {} },
]

const initialWorkflowEdges: WorkflowEdge[] = [
  {
    id: 'asset-1-generate-1',
    type: 'blueprint',
    source: 'asset-1',
    target: 'generate-1',
    sourceHandle: 'reference',
    targetHandle: 'image',
    className: 'edge-blue',
    data: { label: '参考图 -> 图片生成' },
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

function cloneWorkflowNodes(nodes: WorkflowNode[]) {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: {},
  }))
}

function cloneWorkflowEdges(edges: WorkflowEdge[]) {
  return edges.map((edge) => ({
    ...edge,
    data: { ...edge.data },
  }))
}

function createWorkflowCanvas(index: number, base?: WorkflowCanvas): WorkflowCanvas {
  const now = Date.now()
  const id = `canvas-${now}-${crypto.randomUUID()}`

  return {
    id,
    name: base ? `${base.name} 副本` : `画布 ${index}`,
    updatedAt: now,
    nodes: cloneWorkflowNodes(base?.nodes || initialWorkflowNodes),
    edges: cloneWorkflowEdges(base?.edges || initialWorkflowEdges),
    prompt: base?.prompt || '',
    generationMode: base?.generationMode || 'text',
    referenceImages: base?.referenceImages ? [...base.referenceImages] : [],
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

    canvases.push({
      id: canvas.id,
      name: canvas.name || `画布 ${index + 1}`,
      updatedAt: typeof canvas.updatedAt === 'number' ? canvas.updatedAt : Date.now(),
      nodes: Array.isArray(canvas.nodes)
        ? cloneWorkflowNodes(canvas.nodes as WorkflowNode[])
        : cloneWorkflowNodes(initialWorkflowNodes),
      edges: Array.isArray(canvas.edges)
        ? cloneWorkflowEdges(canvas.edges as WorkflowEdge[])
        : cloneWorkflowEdges(initialWorkflowEdges),
      prompt: typeof canvas.prompt === 'string' ? canvas.prompt : '',
      generationMode: canvas.generationMode === 'image' ? 'image' : 'text',
      referenceImages: Array.isArray(canvas.referenceImages)
        ? (canvas.referenceImages as ReferenceImage[])
        : [],
      latestImageId:
        typeof canvas.latestImageId === 'string' ? canvas.latestImageId : undefined,
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
  return `${Date.now()}-${index}-${crypto.randomUUID()}`
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

export function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>('url')
  const [inputFidelity, setInputFidelity] = useState<'low' | 'high'>('high')
  const [canvases, setCanvases] = useState<WorkflowCanvas[]>(loadWorkflowCanvases)
  const [activeCanvasId, setActiveCanvasId] = useState(loadActiveCanvasId)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
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

  const activeCanvas = useMemo(
    () => canvases.find((canvas) => canvas.id === activeCanvasId) || canvases[0],
    [activeCanvasId, canvases]
  )
  const nodes = activeCanvas?.nodes || []
  const edges = activeCanvas?.edges || []
  const prompt = activeCanvas?.prompt || ''
  const generationMode = activeCanvas?.generationMode || 'text'
  const referenceImages = activeCanvas?.referenceImages || []
  const latestImage =
    images.find((image) => image.id === activeCanvas?.latestImageId) || images[0] || null

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

  const setGenerationMode = useCallback(
    (nextMode: 'text' | 'image') => {
      updateActiveCanvas((canvas) => ({ ...canvas, generationMode: nextMode }))
    },
    [updateActiveCanvas]
  )

  const setReferenceImages = useCallback(
    (updater: StateUpdater<ReferenceImage[]>) => {
      updateActiveCanvas((canvas) => ({
        ...canvas,
        referenceImages: resolveUpdater(updater, canvas.referenceImages),
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
      if (settings.persistApiKey && settings.apiKey) setApiKey(settings.apiKey)
    })
    void refreshImages()
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

  async function handleSaveSettings() {
    await saveSettings({ baseUrl, persistApiKey, apiKey, themeMode })
    setStatus(persistApiKey ? '设置已保存' : '设置已保存，API Key 未落盘')
  }

  async function handleThemeChange(nextThemeMode: ThemeMode) {
    setThemeMode(nextThemeMode)
    await saveSettings({
      baseUrl,
      persistApiKey,
      apiKey,
      themeMode: nextThemeMode,
    })
    setStatus('主题已切换')
  }

  async function handleOpenShop() {
    await bridge.openExternal(SHOP_URL)
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
      setApiKey('')
      await refreshImages()
      setStatus(`已导入 ${importedCount} 张图片，API Key 未从备份恢复`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('导入备份失败')
    }
  }

  async function addReferenceFiles(files: FileList | File[]) {
    const imageFiles = [...files].filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const remainingSlots = Math.max(0, 4 - referenceImages.length)
    const selectedFiles = imageFiles.slice(0, remainingSlots)
    const nextImages = await Promise.all(
      selectedFiles.map(async (file) => ({
        id: `${Date.now()}-${crypto.randomUUID()}`,
        name: file.name,
        type: file.type || 'image/png',
        dataUrl: await fileToDataUrl(file),
      }))
    )

    setReferenceImages((current) => [...current, ...nextImages])
    if (imageFiles.length > remainingSlots) setStatus('最多添加 4 张参考图')
  }

  function removeReferenceImage(id: string) {
    setReferenceImages((current) => current.filter((image) => image.id !== id))
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

  async function handleGenerate() {
    const finalPrompt = prompt.trim()
    const generatingCanvasId = activeCanvas?.id
    if (!finalPrompt) {
      setError('请先输入提示词')
      return
    }
    if (generationMode === 'image' && referenceImages.length === 0) {
      setError('图片引导模式需要先添加参考图')
      return
    }

    setError('')
    setStatus(generationMode === 'image' ? '正在根据参考图生成图片...' : '正在生成图片...')
    setGenerationStartedAt(Date.now())
    setGenerationElapsedSeconds(0)
    setGenerationProgress(3)
    setIsGenerating(true)

    try {
      const result = await bridge.generateImages({
        baseUrl,
        apiKey,
        mode: generationMode,
        model,
        prompt: finalPrompt,
        size,
        quality,
        count,
        responseFormat,
        inputFidelity,
        referenceImages: generationMode === 'image' ? referenceImages : undefined,
      })

      const createdAt = Date.now()
      const records = result.images.map((item, index) => ({
        id: newImageId(index),
        src: item.src,
        prompt: finalPrompt,
        model,
        size,
        quality,
        createdAt,
        revisedPrompt: item.revisedPrompt,
        mode: generationMode,
        referenceImageNames:
          generationMode === 'image'
            ? referenceImages.map((image) => image.name)
            : undefined,
      }))

      await saveImages(records)
      if (generatingCanvasId && records[0]) {
        setCanvases((currentCanvases) =>
          currentCanvases.map((canvas) =>
            canvas.id === generatingCanvasId
              ? { ...canvas, latestImageId: records[0].id, updatedAt: Date.now() }
              : canvas
          )
        )
      }
      await refreshImages()
      setGenerationProgress(100)
      setStatus(`已生成 ${records.length} 张图片，已保存到当前浏览器`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('生成失败')
    } finally {
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

    if (id === activeCanvasId) {
      const nextActive =
        nextCanvases[Math.max(0, deletedIndex - 1)] || nextCanvases[0]
      if (nextActive) setActiveCanvasId(nextActive.id)
    }

    setPaneMenu(null)
    setStatus('画布已删除')
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

  const canGenerate = !isGenerating && Boolean(apiKey && baseUrl && model && prompt.trim())

  function nodeDataFor(type: WorkflowNodeType): WorkflowNode['data'] {
    if (type === 'asset') {
      return {
        onDeleteNode: deleteWorkflowNode,
        generationMode,
        setGenerationMode,
        referenceImages,
        addReferenceFiles,
        removeReferenceImage,
      }
    }

    if (type === 'prompt') {
      return {
        onDeleteNode: deleteWorkflowNode,
        prompt,
        setPrompt,
        generationMode,
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
        isGenerating,
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
        data: nodeDataFor(node.type as WorkflowNodeType),
      })),
    [
      nodes,
      generationMode,
      referenceImages,
      prompt,
      model,
      sortedModels,
      size,
      quality,
      count,
      responseFormat,
      inputFidelity,
      isGenerating,
      canGenerate,
      generationProgress,
      generationElapsedSeconds,
      remainingSeconds,
      latestImage,
      deleteWorkflowNode,
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
            (edge.source.startsWith('asset') ? '参考图 -> 图片生成' : '提示词 -> 图片生成'),
          onDelete: deleteWorkflowEdge,
        },
        animated:
          edge.source.includes('prompt') ||
          (isGenerating && edge.source.includes('generate')) ||
          (generationMode === 'image' && edge.source.includes('asset')),
      })),
    [deleteWorkflowEdge, edges, generationMode, isGenerating]
  )

  const isValidConnection: IsValidConnection<WorkflowEdge> = useCallback(
    (connection) => {
      const source = nodes.find((node) => node.id === connection.source)
      const target = nodes.find((node) => node.id === connection.target)
      if (!source || !target || target.type !== 'generate') return false
      if (source.id === target.id) return false

      if (source.type === 'asset') {
        return connection.sourceHandle === 'reference' && connection.targetHandle === 'image'
      }

      if (source.type === 'prompt') {
        return connection.sourceHandle === 'prompt' && connection.targetHandle === 'prompt'
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
        sourceType === 'asset' ? '参考图 -> 图片生成' : '提示词 -> 图片生成'
      const className =
        sourceType === 'asset'
          ? 'edge-blue'
          : sourceType === 'prompt'
            ? 'edge-violet'
            : sourceType === 'generate'
              ? 'edge-pink'
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
              <button
                type='button'
                className='canvas-switch'
                onClick={() => {
                  setActiveCanvasId(canvas.id)
                  setPaneMenu(null)
                  setStatus(`已切换到 ${canvas.name}`)
                }}
                aria-pressed={canvas.id === activeCanvas?.id}
              >
                <strong>{canvas.name}</strong>
                <span>
                  {canvas.nodes.length} 节点 · {canvas.edges.length} 连接
                </span>
              </button>
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
              <p>{activeCanvas?.name || '画布'} · 右键创建节点 · 拖动端口连线</p>
            </div>
          </div>
          <div className='status-pill'>
            <span>{status}</span>
          </div>
        </header>

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
          <label className='field'>
            <span>API Key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type='password'
              placeholder='sk-...'
              spellCheck={false}
            />
          </label>
          <label className='checkbox-row'>
            <input
              type='checkbox'
              checked={persistApiKey}
              onChange={(event) => setPersistApiKey(event.target.checked)}
            />
            <span>将 API Key 保存到当前浏览器</span>
          </label>
          <div className='button-grid'>
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
          <p>图片和设置保存在当前浏览器 IndexedDB。备份文件不包含 API Key。</p>
        </section>

        <section className='dock-panel gallery-dock'>
          <div className='gallery-dock-header'>
            <div>
              <h2>本地图库</h2>
              <p>{images.length} 张图片</p>
            </div>
            <button className='shop-link' onClick={() => void handleOpenShop()}>
              <ShoppingBag size={16} />
              小店
              <ExternalLink size={14} />
            </button>
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

      {previewImage ? (
        <div
          className='preview-overlay'
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
