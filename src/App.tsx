import { useEffect, useMemo, useState } from 'react'
import {
  Download,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
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
  X,
  Trash2,
} from 'lucide-react'
import {
  clearImages,
  deleteImage,
  listImages,
  saveImages,
} from './storage'
import { bridge } from './bridge'
import type { LocalImageRecord, ModelOption, ThemeMode } from './types'

const DEFAULT_BASE_URL = 'https://cc.api-corp.top'
const DEFAULT_MODEL = 'gpt-image-2'
const SHOP_URL = 'https://pay.ldxp.cn/shop/LY6AR08H'

const sizes = ['1024x1024', '1024x1536', '1536x1024', '1024x1792', '1792x1024']
const qualities = ['auto', 'standard', 'hd', 'low', 'medium', 'high']
const counts = [1, 2, 3, 4]
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

function newImageId(index: number) {
  return `${Date.now()}-${index}-${crypto.randomUUID()}`
}

export function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [galleryDir, setGalleryDir] = useState('')
  const [themeMode, setThemeMode] = useState<ThemeMode>('system')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>(
    'url'
  )
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
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

  useEffect(() => {
    void bridge.getSettings().then((settings) => {
      setBaseUrl(settings.baseUrl || DEFAULT_BASE_URL)
      setPersistApiKey(Boolean(settings.persistApiKey))
      setGalleryDir(settings.galleryDir || '')
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

  async function refreshImages() {
    setImages(await listImages())
  }

  async function handleSaveSettings() {
    await bridge.saveSettings({
      baseUrl,
      persistApiKey,
      apiKey,
      themeMode,
      galleryDir,
    })
    setStatus(persistApiKey ? '设置已保存' : '设置已保存，API Key 未落盘')
  }

  async function handleThemeChange(nextThemeMode: ThemeMode) {
    setThemeMode(nextThemeMode)
    await bridge.saveSettings({
      baseUrl,
      persistApiKey,
      apiKey,
      themeMode: nextThemeMode,
      galleryDir,
    })
    setStatus('主题已切换')
  }

  async function handleChooseGalleryDir() {
    if (!bridge.chooseGalleryDir) {
      setStatus('浏览器模式不支持选择本地图库目录')
      return
    }

    const nextGalleryDir = await bridge.chooseGalleryDir()
    if (!nextGalleryDir) return

    setGalleryDir(nextGalleryDir)
    setStatus('图库目录已更新')
  }

  async function handleOpenShop() {
    await bridge.openExternal(SHOP_URL)
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

    setError('')
    setStatus('正在生成图片...')
    setIsGenerating(true)

    try {
      const result = await bridge.generateImages({
        baseUrl,
        apiKey,
        model,
        prompt: finalPrompt,
        size,
        quality,
        count,
        responseFormat,
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
      }))

      await saveImages(records)
      await refreshImages()
      setStatus(`已生成 ${records.length} 张图片，已保存到本机`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus('生成失败')
    } finally {
      setIsGenerating(false)
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
            <p>本地生图测试工具</p>
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
            <span>将 API Key 保存到本机配置</span>
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
          {galleryDir ? <small title={galleryDir}>图库：{galleryDir}</small> : null}
        </div>
      </aside>

      <main className='workspace'>
        <header className='topbar'>
          <div>
            <h2>生成工作台</h2>
            <p>连接模型、生成图片并管理本地图库。</p>
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
            <p>结果会转成本地图片数据保存，关闭软件后仍在本机图库中。</p>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder='例如：一张现代科技风的产品海报，干净背景，柔和光线，高清摄影质感'
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
          {error ? <div className='error-box'>{error}</div> : null}
        </section>

        <section className='gallery-header'>
          <div>
            <h2>本地图库</h2>
            <p>{images.length} 张图片，只保存在当前电脑。</p>
          </div>
          <button className='ghost danger' onClick={handleClearImages} disabled={images.length === 0}>
            <Trash2 size={16} />
            清空图库
          </button>
          <button className='secondary' onClick={() => void handleChooseGalleryDir()}>
            <FolderOpen size={16} />
            更换目录
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
                    {image.size} · {image.quality} ·{' '}
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
    </div>
  )
}
