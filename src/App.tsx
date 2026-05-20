import { useEffect, useMemo, useState } from 'react'
import {
  Download,
  ExternalLink,
  Image as ImageIcon,
  Images,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Save,
  Search,
  ShoppingBag,
  Sparkles,
  Sun,
  Upload,
  X,
  Trash2,
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
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [generationMode, setGenerationMode] = useState<'text' | 'image'>('text')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>(
    'url'
  )
  const [inputFidelity, setInputFidelity] = useState<'low' | 'high'>('high')
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null)
  const [generationProgress, setGenerationProgress] = useState(0)
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0)
  const [images, setImages] = useState<LocalImageRecord[]>([])
  const [previewImage, setPreviewImage] = useState<LocalImageRecord | null>(null)
  const [status, setStatus] = useState('未连接')
  const [error, setError] = useState('')

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
      if (settings.persistApiKey && settings.apiKey) {
        setApiKey(settings.apiKey)
      }
    })
    void refreshImages()
  }, [])

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
      if (event.key === 'Escape') {
        setPreviewImage(null)
      }
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

  async function refreshImages() {
    setImages(await listImages())
  }

  async function handleSaveSettings() {
    await saveSettings({
      baseUrl,
      persistApiKey,
      apiKey,
      themeMode,
    })
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
    if (imageFiles.length > remainingSlots) {
      setStatus('最多添加 4 张参考图')
    }
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

  return (
    <div className='app-shell' data-theme={resolvedTheme}>
      <aside className='sidebar'>
        <div className='brand'>
          <div className='brand-mark'>
            <Sparkles size={22} />
          </div>
          <div>
            <h1>GPT Image Tools</h1>
            <p>Web 本地生图工具</p>
          </div>
        </div>

        <section className='panel'>
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

        <section className='panel'>
          <div className='section-title'>
            <Search size={16} />
            <span>生图参数</span>
          </div>

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

          <div className='field-row'>
            <label className='field'>
              <span>尺寸</span>
              <select value={size} onChange={(event) => setSize(event.target.value)}>
                {sizes.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className='field'>
              <span>数量</span>
              <select
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              >
                {counts.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className='field-row'>
            <label className='field'>
              <span>质量</span>
              <select
                value={quality}
                onChange={(event) => setQuality(event.target.value)}
              >
                {qualities.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className='field'>
              <span>返回</span>
              <select
                value={responseFormat}
                onChange={(event) =>
                  setResponseFormat(event.target.value as 'url' | 'b64_json')
                }
              >
                <option value='url'>url</option>
                <option value='b64_json'>b64_json</option>
              </select>
            </label>
          </div>
        </section>

        <div className='status-bar'>
          <span>{status}</span>
          <small>设置和图库保存在当前浏览器本地</small>
        </div>
      </aside>

      <main className='workspace'>
        <header className='topbar'>
          <div>
            <h2>生成工作台</h2>
            <p>连接上游 API、生成图片并管理浏览器本地图库。</p>
          </div>
          <div className='topbar-actions'>
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
            <button className='shop-link' onClick={() => void handleOpenShop()}>
              <ShoppingBag size={16} />
              小店入口
              <ExternalLink size={14} />
            </button>
          </div>
        </header>

        <section className='prompt-panel'>
          <div>
            <h2>生成图片</h2>
            <p>支持文生图和图片引导，结果只保存到当前浏览器本地图库。</p>
          </div>

          <div className='mode-tabs' aria-label='生成模式'>
            <button
              className={generationMode === 'text' ? 'active' : ''}
              onClick={() => setGenerationMode('text')}
              type='button'
            >
              <Sparkles size={16} />
              文生图
            </button>
            <button
              className={generationMode === 'image' ? 'active' : ''}
              onClick={() => setGenerationMode('image')}
              type='button'
            >
              <Images size={16} />
              图片引导
            </button>
          </div>

          {generationMode === 'image' ? (
            <section
              className='reference-panel'
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                void addReferenceFiles(event.dataTransfer.files)
              }}
            >
              <div>
                <strong>参考图</strong>
                <span>最多 4 张，参考图会发送到你配置的上游 API 用于生成。</span>
              </div>
              <label className='upload-box'>
                <ImageIcon size={18} />
                <span>选择图片</span>
                <input
                  type='file'
                  accept='image/*'
                  multiple
                  onChange={(event) => {
                    if (event.target.files) {
                      void addReferenceFiles(event.target.files)
                    }
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              {referenceImages.length > 0 ? (
                <div className='reference-grid'>
                  {referenceImages.map((image) => (
                    <article key={image.id} className='reference-card'>
                      <img src={image.dataUrl} alt={image.name} />
                      <span title={image.name}>{image.name}</span>
                      <button
                        className='icon-button'
                        onClick={() => removeReferenceImage(image.id)}
                        aria-label={`移除 ${image.name}`}
                        type='button'
                      >
                        <X size={15} />
                      </button>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              generationMode === 'image'
                ? '例如：保留主体姿态和构图，改成现代科技海报风格，柔和光线，高清摄影质感'
                : '例如：一张现代科技风的产品海报，干净背景，柔和光线，高清摄影质感'
            }
          />
          <div className='actions-row'>
            <button
              className='primary'
              onClick={handleGenerate}
              disabled={isGenerating || !apiKey || !baseUrl || !model}
            >
              {isGenerating ? <Loader2 className='spin' size={17} /> : <Sparkles size={17} />}
              开始生成
            </button>
            <button className='ghost' onClick={() => setPrompt('')}>
              清空提示词
            </button>
          </div>
          {generationMode === 'image' ? (
            <label className='field compact-field'>
              <span>参考图保真度</span>
              <select
                value={inputFidelity}
                onChange={(event) =>
                  setInputFidelity(event.target.value as 'low' | 'high')
                }
              >
                {inputFidelities.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? <div className='error-box'>{error}</div> : null}
        </section>

        <section className='gallery-header'>
          <div>
            <h2>本地图库</h2>
            <p>{images.length} 张图片，保存在当前浏览器 IndexedDB。</p>
          </div>
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
          <button className='ghost danger' onClick={handleClearImages} disabled={images.length === 0}>
            <Trash2 size={16} />
            清空图库
          </button>
        </section>

        {images.length === 0 ? (
          <section className='empty-state'>
            <ImageIcon size={42} />
            <h3>还没有生成图片</h3>
            <p>填写 API Key，获取模型后就可以用 gpt-image-2 生图。</p>
          </section>
        ) : (
          <section className='gallery-grid'>
            {images.map((image, index) => (
              <article className='image-card' key={image.id}>
                <button
                  className='image-frame'
                  onClick={() => setPreviewImage(image)}
                  aria-label='打开 1:1 图片预览'
                >
                  <img src={image.src} alt={image.revisedPrompt || image.prompt} />
                </button>
                <div className='image-meta'>
                  <strong>{image.model}</strong>
                  <span>
                    {image.mode === 'image' ? '图片引导' : '文生图'} · {image.size} · {image.quality} ·{' '}
                    {new Date(image.createdAt).toLocaleString()}
                  </span>
                  <p>{image.revisedPrompt || image.prompt}</p>
                </div>
                <div className='card-actions'>
                  <button
                    className='secondary'
                    onClick={() =>
                      downloadDataUrl(image.src, `gpt-image-${index + 1}.png`)
                    }
                  >
                    <Download size={15} />
                    下载
                  </button>
                  <button
                    className='ghost danger'
                    onClick={() => void handleDeleteImage(image.id)}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </main>

      {previewImage ? (
        <div
          className='preview-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='图片预览'
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPreviewImage(null)
            }
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

      {isGenerating ? (
        <section className='generation-progress-floating' aria-live='polite'>
          <div className='generation-progress'>
            <div className='progress-copy'>
              <div>
                <strong>{progressStage(generationProgress, generationMode)}</strong>
                <span>
                  已等待 {formatDuration(generationElapsedSeconds)} · 预计还需{' '}
                  {formatDuration(remainingSeconds)}
                </span>
              </div>
              <b>{generationProgress}%</b>
            </div>
            <div
              className='progress-track'
              role='progressbar'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={generationProgress}
              aria-label='图片生成进度'
            >
              <span style={{ width: `${generationProgress}%` }} />
            </div>
            <p>
              当前接口不会返回真实生成百分比，这里按请求类型、数量和质量估算；图片返回后会自动保存到浏览器本地图库。
            </p>
          </div>
        </section>
      ) : null}
    </div>
  )
}
