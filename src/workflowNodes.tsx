import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  type CSSProperties,
} from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  Download,
  Image as ImageIcon,
  Loader2,
  Palette,
  Play,
  Video,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import type {
  GeneratedVideo,
  LocalImageRecord,
  PromptOptimizationPreset,
  ReferenceImage,
  StyleCategory,
  StyleOption,
} from './types'

type GenerationMode = 'text' | 'image'
export const PROMPT_REFERENCE_HANDLE_IDS = Array.from({ length: 8 }, (_, index) =>
  `reference-${index + 1}`
)

type BaseNodeData = {
  onDeleteNode: (id: string) => void
} & Record<string, unknown>

export type AssetNodeData = {
  referenceImages: ReferenceImage[]
  addReferenceFiles: (files: FileList | File[]) => void
  openGalleryPicker: () => void
  galleryImageCount: number
  removeReferenceImage: (id: string) => void
  updateReferenceImageTitle: (id: string, title: string) => void
  isReferenceTitleDuplicate: (id: string) => boolean
} & BaseNodeData

export type PromptNodeData = {
  prompt: string
  setPrompt: Dispatch<SetStateAction<string>>
  referenceImages: ReferenceImage[]
  optimizationPreset: PromptOptimizationPreset
  optimizationPresets: Array<{ value: PromptOptimizationPreset; label: string }>
  setOptimizationPreset: (preset: PromptOptimizationPreset) => void
  generationMode: GenerationMode
  isOptimizingPrompt: boolean
  canOptimizePrompt: boolean
  onOptimizePrompt: () => void
} & BaseNodeData

export type StyleNodeData = {
  styles: StyleOption[]
  categories: StyleCategory[]
  selectedStyleId: string
  setSelectedStyleId: (id: string) => void
  loadCategory: (category: string) => void
  isLoadingStyles: boolean
} & BaseNodeData

export type GenerateNodeData = {
  size: string
  sizeMode: 'preset' | 'custom'
  sizeOptions: Array<{ value: string; label: string }>
  setSize: (value: string) => void
  setSizeMode: Dispatch<SetStateAction<'preset' | 'custom'>>
  customSizeWidth: string
  customSizeHeight: string
  setCustomSizeWidth: Dispatch<SetStateAction<string>>
  setCustomSizeHeight: Dispatch<SetStateAction<string>>
  sizeValidationError: string
  quality: string
  qualities: string[]
  setQuality: Dispatch<SetStateAction<string>>
  count: number
  counts: number[]
  setCount: Dispatch<SetStateAction<number>>
  responseFormat: 'url' | 'b64_json'
  setResponseFormat: Dispatch<SetStateAction<'url' | 'b64_json'>>
  inputFidelity: 'low' | 'high'
  inputFidelities: readonly ('low' | 'high')[]
  setInputFidelity: Dispatch<SetStateAction<'low' | 'high'>>
  generationMode: GenerationMode
  isGenerating: boolean
  canGenerate: boolean
  onGenerate: () => void
  image: LocalImageRecord | null
  outputTitle: string
  updateOutputTitle: (title: string) => void
  isOutputTitleDuplicate: boolean
  onPreview: (image: LocalImageRecord) => void
  onDownload: (image: LocalImageRecord) => void
} & BaseNodeData

export type VideoNodeData = {
  aspectRatio: string
  aspectRatios: string[]
  setAspectRatio: Dispatch<SetStateAction<string>>
  duration: number
  durations: number[]
  setDuration: Dispatch<SetStateAction<number>>
  resolution: '480p' | '720p'
  resolutions: readonly ('480p' | '720p')[]
  setResolution: Dispatch<SetStateAction<'480p' | '720p'>>
  isGenerating: boolean
  canGenerate: boolean
  onGenerate: () => void
  video: GeneratedVideo | null
  onOpen: (video: GeneratedVideo) => void
} & BaseNodeData

export type OutputNodeData = {
  image: LocalImageRecord | null
  isGenerating: boolean
  onPreview: (image: LocalImageRecord) => void
  onDownload: (image: LocalImageRecord) => void
} & BaseNodeData

export type BlueprintEdgeData = {
  label: string
  onDelete: (id: string) => void
} & Record<string, unknown>

type AssetFlowNode = Node<AssetNodeData, 'asset'>
type PromptFlowNode = Node<PromptNodeData, 'prompt'>
type StyleFlowNode = Node<StyleNodeData, 'style'>
type GenerateFlowNode = Node<GenerateNodeData, 'generate'>
type VideoFlowNode = Node<VideoNodeData, 'video'>
type OutputFlowNode = Node<OutputNodeData, 'output'>
type BlueprintFlowEdge = Edge<BlueprintEdgeData, 'blueprint'>

type MentionState = {
  query: string
  start: number
  end: number
} | null

const CUSTOM_SIZE_VALUE = 'custom'

function parseNodeSizeValue(value: string) {
  const match = value.match(/^(\d{2,5})x(\d{2,5})$/)
  if (!match) return null
  return {
    width: match[1],
    height: match[2],
  }
}

function normalizeMentionTitle(value: string) {
  return value.trim().replace(/^@+/, '')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getMentionState(value: string, caret: number): MentionState {
  const beforeCaret = value.slice(0, caret)
  const atIndex = beforeCaret.lastIndexOf('@')
  if (atIndex < 0) return null

  const query = beforeCaret.slice(atIndex + 1)
  if (/[\s，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’]/.test(query)) return null

  return { query, start: atIndex, end: caret }
}

type PromptMentionSummary = {
  title: string
  isKnown: boolean
}

function getPromptMentionSummary(prompt: string, knownTitles: Set<string>) {
  const orderedTitles = [...knownTitles].sort((a, b) => b.length - a.length)
  if (orderedTitles.length > 0) {
    const mentions: PromptMentionSummary[] = []
    const pattern = new RegExp(`@(${orderedTitles.map(escapeRegExp).join('|')})`, 'g')
    let match: RegExpExecArray | null

    while ((match = pattern.exec(prompt)) !== null) {
      const title = normalizeMentionTitle(match[1] || '')
      if (!title || mentions.some((item) => item.title === title)) continue
      mentions.push({ title, isKnown: knownTitles.has(title) })
    }

    if (mentions.length > 0) return mentions
  }

  const mentions: PromptMentionSummary[] = []
  const pattern = /@([^\s@，。,.!！?？;；:：、()[\]{}<>《》"'“”‘’]+)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(prompt)) !== null) {
    const rawTitle = match[1] || ''
    const title = normalizeMentionTitle(rawTitle)
    if (!title || mentions.some((item) => item.title === title)) continue
    mentions.push({ title, isKnown: knownTitles.has(title) })
  }

  return mentions
}

function NodeShell({
  id,
  accent,
  title,
  subtitle,
  titleAction,
  onDelete,
  children,
}: {
  id: string
  accent: 'blue' | 'violet' | 'pink' | 'green' | 'cyan'
  title: string
  subtitle: string
  titleAction?: ReactNode
  onDelete: (id: string) => void
  children: ReactNode
}) {
  return (
    <section className={`flow-node flow-node-${accent}`}>
      <div className='node-title'>
        <span>{title}</span>
        <div>
          {titleAction}
          <small>{subtitle}</small>
          <button
            type='button'
            className='node-delete nodrag'
            onClick={(event) => {
              event.stopPropagation()
              onDelete(id)
            }}
            aria-label={`删除 ${title}`}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {children}
    </section>
  )
}

export function AssetNode({ id, data }: NodeProps<AssetFlowNode>) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const lastFilePickerOpenAtRef = useRef(0)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingTitleImageId, setEditingTitleImageId] = useState<string | null>(null)
  const referenceImage = data.referenceImages[0] || null
  const isReferenceTitleDuplicate = referenceImage
    ? data.isReferenceTitleDuplicate(referenceImage.id)
    : false
  const referenceTitle = referenceImage?.title ?? referenceImage?.name ?? ''

  useEffect(() => {
    if (!referenceImage) {
      setTitleDraft('')
      setEditingTitleImageId(null)
      return
    }

    if (editingTitleImageId !== referenceImage.id) {
      setTitleDraft(referenceTitle)
    }
  }, [editingTitleImageId, referenceImage, referenceTitle])

  function openReferenceFilePicker() {
    const now = Date.now()
    if (now - lastFilePickerOpenAtRef.current < 800) return

    lastFilePickerOpenAtRef.current = now
    fileInputRef.current?.click()
  }

  function commitReferenceTitle() {
    if (!referenceImage) return
    data.updateReferenceImageTitle(referenceImage.id, titleDraft)
    setEditingTitleImageId(null)
  }

  return (
    <NodeShell
      id={id}
      accent='blue'
      title='参考图片'
      subtitle='Reference'
      onDelete={data.onDeleteNode}
    >
      {referenceImage ? (
        <label
          className={`image-title-field image-title-field-reference nodrag ${isReferenceTitleDuplicate ? 'title-conflict' : ''}`}
          title={isReferenceTitleDuplicate ? '画布内图片名称重复' : '参考图名称'}
        >
          <span>@</span>
          <input
            value={
              editingTitleImageId === referenceImage.id ? titleDraft : referenceTitle
            }
            onFocus={() => {
              setEditingTitleImageId(referenceImage.id)
              setTitleDraft(referenceTitle)
            }}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitReferenceTitle}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setTitleDraft(referenceTitle)
                setEditingTitleImageId(null)
                event.currentTarget.blur()
              }
            }}
            aria-invalid={isReferenceTitleDuplicate}
            placeholder='参考图标题'
            spellCheck={false}
          />
        </label>
      ) : null}
      <div className='node-port-row node-port-row-source'>
        <span>参考图输出</span>
        <Handle type='source' position={Position.Right} id='reference' />
      </div>
      <div
        className={`asset-drop nodrag ${data.referenceImages.length > 0 ? 'asset-drop-filled' : ''}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          data.addReferenceFiles(event.dataTransfer.files)
        }}
      >
        {data.referenceImages.length === 0 ? (
          <>
            <ImageIcon size={34} />
            <strong>拖入图片 / 选择参考图</strong>
            <span>添加后作为生成参考输入</span>
          </>
        ) : (
          <div className={`asset-preview-grid asset-preview-count-${data.referenceImages.length}`}>
            {data.referenceImages.map((image) => (
              <article key={image.id} onDragStart={(event) => event.preventDefault()}>
                <img
                  src={image.dataUrl || ''}
                  alt={image.name}
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                />
                <button
                  type='button'
                  className='node-icon-button'
                  onClick={() => data.removeReferenceImage(image.id)}
                  aria-label={`移除 ${image.name}`}
                >
                  <X size={14} />
                </button>
              </article>
            ))}
          </div>
        )}
        <div className='asset-drop-actions'>
          <button
            type='button'
            className='node-file-button nodrag'
            onClick={openReferenceFilePicker}
            onDoubleClick={(event) => event.preventDefault()}
          >
            <Upload size={15} />
            上传图片
          </button>
          <button
            type='button'
            className='node-file-button nodrag'
            onClick={data.openGalleryPicker}
            disabled={data.galleryImageCount === 0}
            title={data.galleryImageCount === 0 ? '图库暂无图片' : '从图库选择参考图'}
          >
            <ImageIcon size={15} />
            从图库选择
          </button>
        </div>
        <input
          ref={fileInputRef}
          type='file'
          accept='image/*'
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) {
              data.addReferenceFiles(event.target.files)
            }
            event.currentTarget.value = ''
          }}
        />
      </div>
    </NodeShell>
  )
}

export function PromptNode({ id, data }: NodeProps<PromptFlowNode>) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [mentionState, setMentionState] = useState<MentionState>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const referenceTitles = useMemo(
    () =>
      data.referenceImages
        .map((image) => normalizeMentionTitle(image.title || image.name))
        .filter(Boolean),
    [data.referenceImages]
  )
  const knownReferenceTitles = useMemo(() => new Set(referenceTitles), [referenceTitles])
  const mentionSuggestions = useMemo(() => {
    if (!mentionState) return []
    const query = mentionState.query.toLowerCase()
    return referenceTitles
      .filter((title) => title.toLowerCase().includes(query))
      .slice(0, 8)
  }, [mentionState, referenceTitles])
  const mentionSummary = useMemo(
    () => getPromptMentionSummary(data.prompt, knownReferenceTitles),
    [data.prompt, knownReferenceTitles]
  )

  function syncMentionState(textarea: HTMLTextAreaElement) {
    const nextState = getMentionState(textarea.value, textarea.selectionStart)
    setMentionState(nextState)
    setActiveMentionIndex(0)
  }

  function insertMention(title: string) {
    const textarea = textareaRef.current
    if (!textarea || !mentionState) return

    const before = data.prompt.slice(0, mentionState.start)
    const after = data.prompt.slice(mentionState.end)
    const inserted = `@${title} `
    const nextPrompt = `${before}${inserted}${after}`
    const nextCaret = before.length + inserted.length

    data.setPrompt(nextPrompt)
    setMentionState(null)
    window.setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
    }, 0)
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionState || mentionSuggestions.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveMentionIndex((current) => (current + 1) % mentionSuggestions.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveMentionIndex(
        (current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length
      )
      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      insertMention(mentionSuggestions[activeMentionIndex] || mentionSuggestions[0])
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setMentionState(null)
    }
  }

  return (
    <NodeShell
      id={id}
      accent='violet'
      title='文字描述'
      subtitle='Prompt'
      titleAction={
        <button
          type='button'
          className='node-title-action nodrag'
          onClick={(event) => {
            event.stopPropagation()
            data.onOptimizePrompt()
          }}
          disabled={data.isOptimizingPrompt || !data.prompt.trim()}
          aria-label={data.isOptimizingPrompt ? '正在优化提示词' : '优化提示词'}
          title='优化提示词'
        >
          {data.isOptimizingPrompt ? (
            <Loader2 className='spin' size={14} />
          ) : (
            <WandSparkles size={14} />
          )}
          <span>{data.isOptimizingPrompt ? '优化中' : '优化提示词'}</span>
        </button>
      }
      onDelete={data.onDeleteNode}
    >
      <div className='node-port-grid prompt-port-grid'>
        <div className='prompt-reference-port-list'>
          <div className='node-port-row node-port-row-target'>
            <Handle type='target' position={Position.Left} id='style' />
            <span>风格输入</span>
          </div>
          {PROMPT_REFERENCE_HANDLE_IDS.map((handleId, index) => (
            <div key={handleId} className='node-port-row node-port-row-target'>
              <Handle type='target' position={Position.Left} id={handleId} />
              <span>参考图输入 {index + 1}</span>
            </div>
          ))}
        </div>
        <div className='node-port-row node-port-row-source'>
          <span>提示词输出</span>
          <Handle type='source' position={Position.Right} id='prompt' />
        </div>
      </div>
      <label className='prompt-optimization-select nodrag'>
        <span>优化方向</span>
        <select
          value={data.optimizationPreset}
          onChange={(event) =>
            data.setOptimizationPreset(event.target.value as PromptOptimizationPreset)
          }
        >
          {data.optimizationPresets.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <div className='prompt-editor nodrag'>
        <textarea
          ref={textareaRef}
          className='node-textarea prompt-textarea'
          value={data.prompt}
          onChange={(event) => {
            data.setPrompt(event.target.value)
            syncMentionState(event.currentTarget)
          }}
          onKeyDown={handlePromptKeyDown}
          onKeyUp={(event) => syncMentionState(event.currentTarget)}
          onClick={(event) => syncMentionState(event.currentTarget)}
          onBlur={() =>
            window.setTimeout(() => {
              setMentionState(null)
            }, 120)
          }
          placeholder={
            data.generationMode === 'image'
              ? '输入图像生成提示词，例如：使用 @商品图 的包装元素，改成科技海报风格'
            : '产品海报、科技感、高级材质、清晰主视觉；需要参考图时输入 @参考图标题'
          }
        />
        {mentionSummary.length > 0 ? (
          <div className='prompt-reference-summary' aria-label='提示词引用的参考图'>
            {mentionSummary.map((mention) => (
              <span
                key={mention.title}
                className={mention.isKnown ? 'known' : 'missing'}
              >
                @{mention.title}
              </span>
            ))}
          </div>
        ) : null}
        {mentionState ? (
          <div className='prompt-mention-menu'>
            {mentionSuggestions.length > 0 ? (
              mentionSuggestions.map((title, index) => (
                <button
                  key={title}
                  type='button'
                  className={index === activeMentionIndex ? 'active' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertMention(title)
                  }}
                >
                  <span>@</span>
                  {title}
                </button>
              ))
            ) : referenceTitles.length > 0 ? (
              <div className='prompt-mention-empty'>没有匹配的参考图</div>
            ) : (
              <div className='prompt-mention-empty'>先添加图片名称</div>
            )}
          </div>
        ) : null}
      </div>
    </NodeShell>
  )
}

export function StyleNode({ id, data }: NodeProps<StyleFlowNode>) {
  const selectedStyle =
    data.styles.find((style) => style.id === data.selectedStyleId) || null
  const [category, setCategory] = useState(selectedStyle?.category || '')
  useEffect(() => {
    if (selectedStyle && selectedStyle.category !== category) {
      setCategory(selectedStyle.category)
    }
  }, [category, selectedStyle])
  const visibleStyles = useMemo(
    () =>
      category
        ? data.styles.filter((style) => style.category === category)
        : data.styles,
    [category, data.styles]
  )
  const styleKeywords = selectedStyle?.keywords?.slice(0, 4) || []

  return (
    <NodeShell
      id={id}
      accent='blue'
      title='风格选择'
      subtitle='Style'
      onDelete={data.onDeleteNode}
    >
      <div className='node-port-grid style-port-grid'>
        <div className='node-port-row node-port-row-source'>
          <span>风格输出</span>
          <Handle type='source' position={Position.Right} id='style' />
        </div>
      </div>

      <div className='style-node-body nodrag'>
        <label>
          <span>分类</span>
          <select
            value={category}
            disabled={data.isLoadingStyles || data.categories.length === 0}
            onChange={(event) => {
              const nextCategory = event.target.value
              setCategory(nextCategory)
              if (nextCategory) data.loadCategory(nextCategory)
              const firstStyle = data.styles.find((style) =>
                nextCategory ? style.category === nextCategory : true
              )
              data.setSelectedStyleId(firstStyle?.id || '')
            }}
          >
            <option value=''>选择分类</option>
            {data.categories.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name} · {item.count}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>风格</span>
          <select
            value={data.selectedStyleId}
            disabled={data.isLoadingStyles || visibleStyles.length === 0}
            onChange={(event) => data.setSelectedStyleId(event.target.value)}
          >
            {visibleStyles.length === 0 ? (
              <option value=''>暂无风格</option>
            ) : (
              visibleStyles.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
                </option>
              ))
            )}
          </select>
        </label>

        <div className='style-preview-frame'>
          {selectedStyle?.previewUrl ? (
            <img
              src={selectedStyle.previewUrl}
              alt={`${selectedStyle.name} 风格示例`}
              loading='lazy'
            />
          ) : (
            <div>
              {data.isLoadingStyles ? <Loader2 className='spin' size={28} /> : <Palette size={32} />}
              <span>{data.isLoadingStyles ? 'LOADING' : 'NO STYLE'}</span>
            </div>
          )}
        </div>

        {selectedStyle ? (
          <div className='style-node-meta'>
            <strong>{selectedStyle.category} / {selectedStyle.name}</strong>
            {styleKeywords.length > 0 ? (
              <div>
                {styleKeywords.map((keyword) => (
                  <span key={keyword}>{keyword}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className='style-node-empty'>右侧选择一个风格后，生成时会把对应 JSON 协议加入提示词。</p>
        )}
      </div>
    </NodeShell>
  )
}

export function GenerateNode({ id, data }: NodeProps<GenerateFlowNode>) {
  return (
    <NodeShell
      id={id}
      accent='pink'
      title='图片生成'
      subtitle='Generation'
      onDelete={data.onDeleteNode}
    >
      <label
        className={`image-title-field image-title-field-generate nodrag ${data.isOutputTitleDuplicate ? 'title-conflict' : ''}`}
        title={data.isOutputTitleDuplicate ? '画布内图片名称重复' : '生成图输出名称'}
      >
        <span>@</span>
        <input
          value={data.outputTitle}
          onChange={(event) => data.updateOutputTitle(event.target.value)}
          aria-invalid={data.isOutputTitleDuplicate}
          placeholder='生成图名称'
          spellCheck={false}
        />
      </label>
      <div className='node-port-grid generate-port-grid'>
        <div className='node-port-row node-port-row-target'>
          <Handle type='target' position={Position.Left} id='prompt' />
          <span>提示词输入</span>
        </div>
        <div className='node-port-row node-port-row-source node-port-row-output'>
          <span>生成图片输出</span>
          <Handle type='source' position={Position.Right} id='generated-image' />
        </div>
      </div>
      <div className='generation-preview'>
        {data.image ? (
          <button
            type='button'
            className='node-preview-button nodrag'
            onClick={() => data.onPreview(data.image!)}
            aria-label='打开生成图片预览'
          >
            <img src={data.image.src} alt={data.image.revisedPrompt || data.image.prompt} />
          </button>
        ) : data.isGenerating ? (
          <Loader2 className='spin' size={44} />
        ) : (
          <>
            <ImageIcon size={42} />
            <span>NO IMAGE</span>
          </>
        )}
      </div>
      <div className='node-param-grid nodrag'>
        <label className='node-param-size-field'>
          <span>尺寸</span>
          <select
            value={data.sizeMode === 'custom' ? CUSTOM_SIZE_VALUE : data.size}
            onChange={(event) => {
              const nextSize = event.target.value
              if (nextSize === CUSTOM_SIZE_VALUE) {
                const parsedSize = parseNodeSizeValue(data.size)
                if (parsedSize) {
                  data.setCustomSizeWidth(parsedSize.width)
                  data.setCustomSizeHeight(parsedSize.height)
                }
                data.setSizeMode('custom')
                return
              }
              data.setSizeMode('preset')
              data.setSize(nextSize)
            }}
          >
            {data.sizeOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
            <option value={CUSTOM_SIZE_VALUE}>自定义尺寸</option>
          </select>
        </label>
        {data.sizeMode === 'custom' ? (
          <div className='node-param-custom-size-field'>
            <label>
              <span>宽</span>
              <input
                type='number'
                min='64'
                max='4096'
                step='16'
                value={data.customSizeWidth}
                onChange={(event) => data.setCustomSizeWidth(event.target.value)}
                aria-invalid={Boolean(data.sizeValidationError)}
                aria-label='自定义宽度'
              />
            </label>
            <label>
              <span>高</span>
              <input
                type='number'
                min='64'
                max='4096'
                step='16'
                value={data.customSizeHeight}
                onChange={(event) => data.setCustomSizeHeight(event.target.value)}
                aria-invalid={Boolean(data.sizeValidationError)}
                aria-label='自定义高度'
              />
            </label>
            {data.sizeValidationError ? (
              <p className='node-param-error' role='alert'>
                {data.sizeValidationError}
              </p>
            ) : null}
          </div>
        ) : null}
        <label>
          <span>质量</span>
          <select
            value={data.quality}
            onChange={(event) => data.setQuality(event.target.value)}
          >
            {data.qualities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>数量</span>
          <select
            value={data.count}
            onChange={(event) => data.setCount(Number(event.target.value))}
          >
            {data.counts.map((item) => (
              <option key={item} value={item}>
                {item}x
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>返回</span>
          <select
            value={data.responseFormat}
            onChange={(event) =>
              data.setResponseFormat(event.target.value as 'url' | 'b64_json')
            }
          >
            <option value='url'>url</option>
            <option value='b64_json'>b64_json</option>
          </select>
        </label>
        <label>
          <span>保真</span>
          <select
            value={data.inputFidelity}
            disabled={data.generationMode !== 'image'}
            onChange={(event) => data.setInputFidelity(event.target.value as 'low' | 'high')}
          >
            {data.inputFidelities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className='node-action-bar nodrag'>
        <div>
          <strong>{data.isGenerating ? '等待生成结果' : '等待执行'}</strong>
          <span>{data.isGenerating ? '正在请求上游生成' : '输入提示词后立即生成'}</span>
        </div>
        <button type='button' onClick={data.onGenerate} disabled={!data.canGenerate}>
          {data.isGenerating ? <Loader2 className='spin' size={16} /> : <Play size={16} />}
          {data.isGenerating ? '等待结果' : '立即生成'}
        </button>
      </div>
      {data.image ? (
        <div className='output-actions nodrag'>
          <button type='button' onClick={() => data.onDownload(data.image!)}>
            <Download size={15} />
            下载结果
          </button>
          <button type='button' onClick={() => data.onPreview(data.image!)}>
            打开预览
          </button>
        </div>
      ) : null}
    </NodeShell>
  )
}

export function VideoNode({ id, data }: NodeProps<VideoFlowNode>) {
  return (
    <NodeShell
      id={id}
      accent='cyan'
      title='视频生成'
      subtitle='Video'
      onDelete={data.onDeleteNode}
    >
      <div className='node-port-grid generate-port-grid'>
        <div className='node-port-row node-port-row-target'>
          <Handle type='target' position={Position.Left} id='prompt' />
          <span>提示词输入</span>
        </div>
      </div>
      <div className='generation-preview video-generation-preview'>
        {data.video ? (
          <video src={data.video.src} controls playsInline preload='metadata' />
        ) : data.isGenerating ? (
          <Loader2 className='spin' size={44} />
        ) : (
          <>
            <Video size={42} />
            <span>NO VIDEO</span>
          </>
        )}
      </div>
      <div className='node-param-grid nodrag'>
        <label>
          <span>比例</span>
          <select
            value={data.aspectRatio}
            onChange={(event) => data.setAspectRatio(event.target.value)}
          >
            {data.aspectRatios.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>时长</span>
          <select
            value={data.duration}
            onChange={(event) => data.setDuration(Number(event.target.value))}
          >
            {data.durations.map((item) => (
              <option key={item} value={item}>
                {item}s
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>清晰度</span>
          <select
            value={data.resolution}
            onChange={(event) => data.setResolution(event.target.value as '480p' | '720p')}
          >
            {data.resolutions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className='node-action-bar nodrag'>
        <div>
          <strong>{data.isGenerating ? '等待生成结果' : '等待视频接口'}</strong>
          <span>{data.isGenerating ? '正在请求上游生成' : '提示词节点已可连接，接口接入后即可执行'}</span>
        </div>
        <button type='button' onClick={data.onGenerate} disabled={!data.canGenerate}>
          {data.isGenerating ? <Loader2 className='spin' size={16} /> : <Play size={16} />}
          {data.isGenerating ? '等待结果' : '生成视频'}
        </button>
      </div>
      {data.video ? (
        <div className='output-actions nodrag'>
          <button type='button' onClick={() => data.onOpen(data.video!)}>
            <Video size={15} />
            打开视频
          </button>
        </div>
      ) : null}
    </NodeShell>
  )
}

export function OutputNode({ id, data }: NodeProps<OutputFlowNode>) {
  return (
    <NodeShell
      id={id}
      accent='green'
      title='输出预览'
      subtitle='Result'
      onDelete={data.onDeleteNode}
    >
      <Handle type='target' position={Position.Left} />
      <div className='output-frame nodrag'>
        {data.image ? (
          <button
            type='button'
            onClick={() => data.onPreview(data.image!)}
            aria-label='打开生成图片预览'
          >
            <img src={data.image.src} alt={data.image.revisedPrompt || data.image.prompt} />
          </button>
        ) : (
          <>
            <ImageIcon size={44} />
            <span>{data.isGenerating ? 'GENERATING' : 'NO OUTPUT'}</span>
          </>
        )}
      </div>
      {data.image ? (
        <div className='output-actions nodrag'>
          <button type='button' onClick={() => data.onDownload(data.image!)}>
            <Download size={15} />
            下载
          </button>
          <button type='button' onClick={() => data.onPreview(data.image!)}>
            打开预览
          </button>
        </div>
      ) : null}
    </NodeShell>
  )
}

export function BlueprintEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<BlueprintFlowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const onDeleteRef = useRef(data?.onDelete)

  useEffect(() => {
    onDeleteRef.current = data?.onDelete
  }, [data?.onDelete])

  useEffect(() => {
    const button = deleteButtonRef.current
    if (!button) return

    // Edge labels live in React Flow's portal, so bind directly to avoid pane/edge layers swallowing the delete action.
    const stopEvent = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      stopEvent(event)
      if (event.button === 0) onDeleteRef.current?.(id)
    }
    const handleClick = (event: globalThis.MouseEvent) => {
      stopEvent(event)
      if (event.detail === 0) onDeleteRef.current?.(id)
    }

    button.addEventListener('pointerdown', handlePointerDown)
    button.addEventListener('click', handleClick)
    return () => {
      button.removeEventListener('pointerdown', handlePointerDown)
      button.removeEventListener('click', handleClick)
    }
  }, [id])

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} interactionWidth={0} />
      <EdgeLabelRenderer>
        <div
          className={`edge-label nodrag nopan ${selected ? 'edge-label-selected' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <button
            ref={deleteButtonRef}
            type='button'
            title='断开连接'
            aria-label={`删除连接 ${data?.label || id}`}
          >
            <X size={12} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export function GalleryStrip({
  images,
  limit = 8,
  onPreview,
  onDownload,
  onDelete,
}: {
  images: LocalImageRecord[]
  limit?: number
  onPreview: (image: LocalImageRecord) => void
  onDownload: (image: LocalImageRecord, index: number) => void
  onDelete: (id: string) => void
}) {
  const visibleImages = useMemo(() => images.slice(0, limit), [images, limit])
  const stripRef = useRef<HTMLDivElement | null>(null)
  const [columnCount, setColumnCount] = useState(1)
  const [imageRatios, setImageRatios] = useState<Record<string, number>>({})

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return

    const updateColumnCount = () => {
      const width = strip.getBoundingClientRect().width
      const minColumnWidth = width < 620 ? 220 : 300
      const gap = 12
      const nextCount = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      setColumnCount(Math.min(nextCount, 5, Math.max(1, visibleImages.length)))
    }

    updateColumnCount()
    const observer = new ResizeObserver(updateColumnCount)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [visibleImages.length])

  useEffect(() => {
    let isCancelled = false
    const missingImages = visibleImages.filter((image) => !imageRatios[image.id])
    if (missingImages.length === 0) return

    for (const image of missingImages) {
      const loader = new Image()
      loader.onload = () => {
        if (isCancelled || !loader.naturalWidth || !loader.naturalHeight) return
        setImageRatios((current) => ({
          ...current,
          [image.id]: loader.naturalHeight / loader.naturalWidth,
        }))
      }
      loader.src = image.src
    }

    return () => {
      isCancelled = true
    }
  }, [visibleImages, imageRatios])

  const masonryColumns = useMemo(() => {
    const columns = Array.from({ length: columnCount }, () => ({
      height: 0,
      items: [] as Array<{ image: LocalImageRecord; index: number }>,
    }))

    visibleImages.forEach((image, index) => {
      const targetColumn = columns.reduce((shortest, column, columnIndex) =>
        column.height < columns[shortest].height ? columnIndex : shortest
      , 0)
      columns[targetColumn].items.push({ image, index })
      columns[targetColumn].height += imageRatios[image.id] || 1
    })

    return columns
  }, [columnCount, imageRatios, visibleImages])

  return (
    <div
      className='gallery-strip'
      ref={stripRef}
      style={{ '--gallery-columns': columnCount } as CSSProperties}
    >
      {masonryColumns.map((column, columnIndex) => (
        <div className='gallery-column' key={`gallery-column-${columnIndex}`}>
          {column.items.map(({ image, index }) => (
            <article key={image.id} className='gallery-tile'>
              <button
                type='button'
                className='gallery-tile-preview'
                onClick={() => onPreview(image)}
                aria-label='打开图片预览'
              >
                <img src={image.src} alt={image.revisedPrompt || image.prompt} />
              </button>
              <div className='gallery-tile-overlay'>
                <div className='gallery-tile-copy'>
                  <strong>{image.mode === 'image' ? '图片引导' : '文生图'}</strong>
                  <span>{new Date(image.createdAt).toLocaleString()}</span>
                  <p>{image.revisedPrompt || image.prompt}</p>
                </div>
                <nav aria-label='图片操作'>
                  <button type='button' onClick={() => onDownload(image, index)} aria-label='下载图片'>
                    <Download size={14} />
                  </button>
                  <button type='button' onClick={() => onDelete(image.id)} aria-label='删除图片'>
                    <Trash2 size={14} />
                  </button>
                </nav>
              </div>
            </article>
          ))}
          {column.items.length === 0 ? (
            <span className='gallery-column-placeholder' aria-hidden='true' />
          ) : null}
        </div>
      ))}
    </div>
  )
}

export const nodeTypes = {
  asset: AssetNode,
  prompt: PromptNode,
  style: StyleNode,
  generate: GenerateNode,
  video: VideoNode,
  output: OutputNode,
}

export const edgeTypes = {
  blueprint: BlueprintEdge,
}
