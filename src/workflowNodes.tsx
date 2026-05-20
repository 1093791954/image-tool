import type { Dispatch, ReactNode, SetStateAction } from 'react'
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
  Images,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import type { LocalImageRecord, ReferenceImage } from './types'

type GenerationMode = 'text' | 'image'

type BaseNodeData = {
  onDeleteNode: (id: string) => void
} & Record<string, unknown>

export type AssetNodeData = {
  generationMode: GenerationMode
  setGenerationMode: Dispatch<SetStateAction<GenerationMode>>
  referenceImages: ReferenceImage[]
  addReferenceFiles: (files: FileList | File[]) => void
  removeReferenceImage: (id: string) => void
} & BaseNodeData

export type PromptNodeData = {
  prompt: string
  setPrompt: Dispatch<SetStateAction<string>>
  generationMode: GenerationMode
  isOptimizingPrompt: boolean
  canOptimizePrompt: boolean
  onOptimizePrompt: () => void
} & BaseNodeData

export type GenerateNodeData = {
  model: string
  sortedModels: Array<{ id: string }>
  setModel: Dispatch<SetStateAction<string>>
  size: string
  sizes: string[]
  setSize: Dispatch<SetStateAction<string>>
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
  progressLabel: string
  progressDetail: string
  generationProgress: number
  image: LocalImageRecord | null
  onPreview: (image: LocalImageRecord) => void
  onDownload: (image: LocalImageRecord) => void
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
type GenerateFlowNode = Node<GenerateNodeData, 'generate'>
type OutputFlowNode = Node<OutputNodeData, 'output'>
type BlueprintFlowEdge = Edge<BlueprintEdgeData, 'blueprint'>

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
  accent: 'blue' | 'violet' | 'pink' | 'green'
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
  return (
    <NodeShell
      id={id}
      accent='blue'
      title='参考图片'
      subtitle='Reference'
      onDelete={data.onDeleteNode}
    >
      <div className='node-port-row node-port-row-source'>
        <span>参考图输出</span>
        <Handle type='source' position={Position.Right} id='reference' />
      </div>
      <div
        className='asset-drop nodrag'
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          data.setGenerationMode('image')
          data.addReferenceFiles(event.dataTransfer.files)
        }}
      >
        {data.referenceImages.length === 0 ? (
          <>
            <ImageIcon size={34} />
            <strong>拖入图片 / 选择参考图</strong>
            <span>点击或拖入图片后自动切到图片引导</span>
          </>
        ) : (
          <div className='asset-preview-grid'>
            {data.referenceImages.map((image) => (
              <article key={image.id}>
                <img src={image.dataUrl} alt={image.name} />
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
        <label className='node-file-button'>
          <Upload size={15} />
          选择图片
          <input
            type='file'
            accept='image/*'
            multiple
            onChange={(event) => {
              if (event.target.files) {
                data.setGenerationMode('image')
                data.addReferenceFiles(event.target.files)
              }
              event.currentTarget.value = ''
            }}
          />
        </label>
      </div>
      <div className='node-toggle nodrag' aria-label='生成模式'>
        <button
          type='button'
          className={data.generationMode === 'text' ? 'active' : ''}
          onClick={() => data.setGenerationMode('text')}
        >
          <Sparkles size={14} />
          文生图
        </button>
        <button
          type='button'
          className={data.generationMode === 'image' ? 'active' : ''}
          onClick={() => data.setGenerationMode('image')}
        >
          <Images size={14} />
          图片引导
        </button>
      </div>
    </NodeShell>
  )
}

export function PromptNode({ id, data }: NodeProps<PromptFlowNode>) {
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
          aria-label='优化提示词'
          title='优化提示词'
        >
          {data.isOptimizingPrompt ? (
            <Loader2 className='spin' size={14} />
          ) : (
            <WandSparkles size={14} />
          )}
        </button>
      }
      onDelete={data.onDeleteNode}
    >
      <div className='node-port-row node-port-row-source'>
        <span>提示词输出</span>
        <Handle type='source' position={Position.Right} id='prompt' />
      </div>
      <textarea
        className='node-textarea nodrag'
        value={data.prompt}
        onChange={(event) => data.setPrompt(event.target.value)}
        placeholder={
          data.generationMode === 'image'
            ? '输入图像生成提示词，例如：保留主体姿态，改成科技海报风格，清晰主视觉'
            : '产品海报、科技感、高级材质、清晰主视觉'
        }
      />
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
      <div className='node-port-grid'>
        <div className='node-input-stack'>
          <div className='node-port-row node-port-row-target'>
            <Handle type='target' position={Position.Left} id='image' />
            <span>参考图输入</span>
          </div>
          <div className='node-port-row node-port-row-target'>
            <Handle type='target' position={Position.Left} id='prompt' />
            <span>提示词输入</span>
          </div>
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
        <label>
          <span>模型</span>
          <select value={data.model} onChange={(event) => data.setModel(event.target.value)}>
            {data.sortedModels.length === 0 ? (
              <option value={data.model}>{data.model}</option>
            ) : (
              data.sortedModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          <span>尺寸</span>
          <select value={data.size} onChange={(event) => data.setSize(event.target.value)}>
            {data.sizes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
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
          <strong>{data.isGenerating ? data.progressLabel : '等待执行'}</strong>
          <span>{data.isGenerating ? data.progressDetail : '输入提示词后立即生成'}</span>
        </div>
        <button type='button' onClick={data.onGenerate} disabled={!data.canGenerate}>
          {data.isGenerating ? <Loader2 className='spin' size={16} /> : <Play size={16} />}
          立即生成
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
      {data.isGenerating ? (
        <div className='node-progress' aria-label='图片生成进度'>
          <span style={{ width: `${data.generationProgress}%` }} />
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

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      {selected ? (
        <EdgeLabelRenderer>
          <div
            className='edge-label nodrag nopan'
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <button
              type='button'
              onClick={() => data?.onDelete(id)}
              aria-label={`删除连接 ${data?.label || id}`}
            >
              <X size={12} />
            </button>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export function GalleryStrip({
  images,
  onPreview,
  onDownload,
  onDelete,
}: {
  images: LocalImageRecord[]
  onPreview: (image: LocalImageRecord) => void
  onDownload: (image: LocalImageRecord, index: number) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className='gallery-strip'>
      {images.slice(0, 8).map((image, index) => (
        <article key={image.id}>
          <button type='button' onClick={() => onPreview(image)} aria-label='打开图片预览'>
            <img src={image.src} alt={image.revisedPrompt || image.prompt} />
          </button>
          <div>
            <strong>{image.mode === 'image' ? '图片引导' : '文生图'}</strong>
            <span>{new Date(image.createdAt).toLocaleString()}</span>
          </div>
          <nav>
            <button type='button' onClick={() => onDownload(image, index)} aria-label='下载图片'>
              <Download size={14} />
            </button>
            <button type='button' onClick={() => onDelete(image.id)} aria-label='删除图片'>
              <Trash2 size={14} />
            </button>
          </nav>
        </article>
      ))}
    </div>
  )
}

export const nodeTypes = {
  asset: AssetNode,
  prompt: PromptNode,
  generate: GenerateNode,
  output: OutputNode,
}

export const edgeTypes = {
  blueprint: BlueprintEdge,
}
