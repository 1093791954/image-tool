import type {
  CommerceDetailPromptPayload,
  CommerceMainPromptPayload,
  ImageApiClient,
  ImageGenerationPayload,
  ImageGenerationResult,
  ImageGenerationTask,
  ManagedNewApiLoginResult,
  ModelOption,
  NegativePromptOptimizationPayload,
  PromptOptimizationPayload,
  ReferenceImage,
  SketchDescriptionPayload,
  StyleCategory,
  StyleCategoryResult,
  StyleLibraryResult,
} from './types'
import {
  buildCommerceDetailPromptSystemInstruction,
  buildCommerceDetailPromptUserText,
  buildCommerceMainPromptSystemInstruction,
  buildCommerceMainPromptUserText,
  buildNegativePromptOptimizationMessages,
  buildPromptOptimizationMessages,
} from './promptEngineering'

const NEW_API_BASE_URL = 'https://hotapi.top'
const NEW_API_LOGIN_PROXY_PATH = '/api/newapi/login-key'
const OPENAI_PROXY_PATH = '/api/openai'

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Base URL is required')
  return trimmed
}

function openAiProxyUrl(baseUrl: string, path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${OPENAI_PROXY_PATH}${normalizedPath}?baseUrl=${encodeURIComponent(normalizeBaseUrl(baseUrl))}`
}

function normalizeNewApiBaseUrl(value: string) {
  const baseUrl = normalizeBaseUrl(value || NEW_API_BASE_URL)
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' || !['hotapi.top', 'www.hotapi.top'].includes(parsed.host)) {
    throw new Error('当前只允许登录 https://hotapi.top/')
  }
  return `${parsed.protocol}//${parsed.host}`
}

function headers(apiKey: string) {
  const key = apiKey.trim()
  if (!key) throw new Error('API Key is required')
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

function imageTaskHeaders(apiKey: string) {
  return {
    ...headers(apiKey),
  }
}

function imageTaskAuthHeaders(apiKey: string) {
  const key = apiKey.trim()
  if (!key) throw new Error('API Key is required')
  return {
    Authorization: `Bearer ${key}`,
  }
}

function imageTaskBilling(payload: {
  billingToken?: string
  billingUserId?: number
  billingTokenId?: number
  billingTokenName?: string
}) {
  if (!payload.billingToken) return undefined
  return {
    token: payload.billingToken,
    userId: payload.billingUserId,
    tokenId: payload.billingTokenId,
    tokenName: payload.billingTokenName,
  }
}

function responseSnippet(text: string) {
  return (
    text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240) || '空响应'
  )
}

function cleanErrorMessage(message: string) {
  const normalized = message.trim()
  if (!normalized) return ''

  const title = normalized.match(/<title>\s*([\s\S]*?)\s*<\/title>/i)?.[1]
  const source = title || normalized
  const cleaned =
    source
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240) || normalized.slice(0, 240)

  if (/origin web server returned an invalid or incomplete response/i.test(cleaned)) {
    return 'Cloudflare 无法从上游源站拿到完整响应，通常是中转站/模型上游临时过载或配置异常。请稍后重试，或切换图片 API Base URL/模型后再试。'
  }

  return cleaned
}

function parseEventStreamBody(text: string) {
  const dataLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))

  if (dataLines.length === 0) return null

  let content = ''
  let lastBody: any = null
  for (const line of dataLines) {
    const payload = line.replace(/^data:\s*/, '')
    if (!payload || payload === '[DONE]') continue
    try {
      const body = JSON.parse(payload)
      lastBody = body
      const delta = body?.choices?.[0]?.delta?.content
      const message = body?.choices?.[0]?.message?.content
      if (typeof delta === 'string') content += delta
      if (!content && typeof message === 'string') content = message
    } catch {
      return null
    }
  }

  if (content.trim()) {
    return { choices: [{ message: { content: content.trim() } }] }
  }
  return lastBody
}

function isEmptyPromptOptimizationError(error: unknown) {
  return error instanceof Error && error.message.includes('模型没有返回优化后的提示词')
}

async function parseJsonResponse<T>(response: Response, prefix: string) {
  const text = await response.text()
  const contentType = response.headers.get('content-type') || 'unknown content-type'
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = parseEventStreamBody(text)
      if (!body) {
        throw new Error(
          `${prefix}: 上游没有返回 JSON（HTTP ${response.status}，${contentType}）：${responseSnippet(text)}`
        )
      }
    }
  }

  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText
    throw new Error(`${prefix}: ${cleanErrorMessage(String(message))}`)
  }

  if (!body) {
    throw new Error(`${prefix}: upstream returned an empty response`)
  }

  return body as T
}

function newApiProxyFetchErrorMessage(prefix: string) {
  return `${prefix}: 登录代理不可用。请确认已部署或启动同源接口 ${NEW_API_LOGIN_PROXY_PATH}。`
}

function assertApiSuccess<T>(
  body: { success?: boolean; message?: string; data?: T },
  fallback: string
): T {
  if (!body?.success) {
    throw new Error(cleanErrorMessage(body?.message || fallback))
  }
  if (body.data === undefined) {
    throw new Error(fallback)
  }
  return body.data
}

async function obtainManagedNewApiKey(payload: {
  baseUrl: string
  username: string
  password: string
}): Promise<ManagedNewApiLoginResult> {
  const baseUrl = normalizeNewApiBaseUrl(payload.baseUrl)
  let response: Response
  try {
    response = await fetch(NEW_API_LOGIN_PROXY_PATH, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        baseUrl,
        username: payload.username,
        password: payload.password,
      }),
    })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(newApiProxyFetchErrorMessage('中转站登录失败'))
    }
    throw error
  }

  const body = await parseJsonResponse<{
    success?: boolean
    message?: string
    data?: ManagedNewApiLoginResult
  }>(response, '中转站登录代理失败')
  return assertApiSuccess(body, '中转站登录失败')
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeRetryCount(value: unknown) {
  const count = Math.floor(Number(value ?? 1))
  if (!Number.isFinite(count)) return 1
  return Math.max(0, Math.min(5, count))
}

function isTransientUpstreamStatus(status: number) {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 520 ||
    status === 521 ||
    status === 522 ||
    status === 523 ||
    status === 524 ||
    status === 525 ||
    status === 526
  )
}

function isRetryableUpstreamError(error: unknown) {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /cloudflare|proxy read timeout|120-second|origin web server|invalid or incomplete response|upstream returned an empty response|networkerror|failed to fetch/i.test(
    message
  )
}

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  prefix: string,
  retryCount?: number,
  onRetry?: (attempt: number, maxAttempts: number, status: number) => void
) {
  const retries = normalizeRetryCount(retryCount)
  const maxAttempts = retries + 1
  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init)
      if (!response.ok && isTransientUpstreamStatus(response.status) && attempt < maxAttempts) {
        onRetry?.(attempt, maxAttempts, response.status)
        await delay(800)
        continue
      }
      try {
        return await parseJsonResponse<T>(response, prefix)
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts && isRetryableUpstreamError(error)) {
          onRetry?.(attempt, maxAttempts, response.status)
          await delay(800)
          continue
        }
        throw error
      }
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts && isRetryableUpstreamError(error)) {
        onRetry?.(attempt, maxAttempts, 0)
        await delay(800)
        continue
      }
      throw error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || `${prefix}: 请求失败`))
}

async function urlToDataUrl(url: string) {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`)
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch (error) {
    throw new Error(
      `图片已生成，但浏览器无法下载返回的图片 URL。请在控制台把响应格式切换为 b64_json 后重试。${error instanceof Error ? ` 原因：${error.message}` : ''}`
    )
  }
}

function blobFromDataUrl(dataUrl: string) {
  const [header, base64] = dataUrl.split(',')
  const type = header.match(/^data:([^;]+);base64$/)?.[1] || 'image/png'
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type })
}

const IMAGE_EDIT_REFERENCE_MAX_SIDE = 1024
const IMAGE_EDIT_REFERENCE_JPEG_QUALITY = 0.9

function imageEditReferenceName(image: ReferenceImage) {
  const source = (image.name || image.title || 'reference.jpg').trim() || 'reference.jpg'
  return source.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
}

function loadReferenceImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('参考图无法读取，请换用 PNG 或 JPG 图片后重试'))
    image.src = dataUrl
  })
}

async function normalizeImageEditReference(image: ReferenceImage, model: string) {
  if (!model.trim().toLowerCase().startsWith('gpt-image')) return image

  const loaded = await loadReferenceImage(image.dataUrl)
  const sourceWidth = loaded.naturalWidth || loaded.width
  const sourceHeight = loaded.naturalHeight || loaded.height
  if (!sourceWidth || !sourceHeight) {
    throw new Error(`参考图 ${image.title || image.name || image.id} 无法读取尺寸`)
  }

  const scale = Math.min(1, IMAGE_EDIT_REFERENCE_MAX_SIDE / Math.max(sourceWidth, sourceHeight))
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale))
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = drawWidth
  canvas.height = drawHeight
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('浏览器无法处理参考图，请换用 PNG 或 JPG 图片后重试')
  }

  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  let dataUrl: string
  try {
    context.drawImage(loaded, 0, 0, drawWidth, drawHeight)
    dataUrl = canvas.toDataURL('image/jpeg', IMAGE_EDIT_REFERENCE_JPEG_QUALITY)
  } catch {
    throw new Error(`参考图 ${image.title || image.name || image.id} 无法转换为 JPG，请换用 PNG 或 JPG 图片后重试`)
  }

  return {
    ...image,
    name: imageEditReferenceName(image),
    type: 'image/jpeg',
    dataUrl,
  }
}

async function normalizeImageEditReferences(references: ReferenceImage[], model: string) {
  return Promise.all(references.map((image) => normalizeImageEditReference(image, model)))
}

function normalizedImageApiSize(model: string, size: string) {
  const normalizedModel = model.trim().toLowerCase()
  if (!normalizedModel.startsWith('gpt-image')) return size
  if (size === 'auto') return size
  const supportedSizes = new Set(['1024x1024', '1024x1536', '1536x1024'])
  if (supportedSizes.has(size)) return size

  const match = size.match(/^(\d{2,5})x(\d{2,5})$/)
  if (!match) return size
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return size
  if (Math.abs(width - height) / Math.max(width, height) < 0.08) return '1024x1024'
  return height > width ? '1024x1536' : '1536x1024'
}

function shouldSendImageResponseFormat(model: string, responseFormat: 'url' | 'b64_json') {
  return responseFormat === 'b64_json' && model.trim().toLowerCase() !== 'gpt-image-2'
}

async function parseImageResult(
  body: { data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> }
) {
  const images: ImageGenerationResult['images'] = []
  for (const item of body.data || []) {
    if (item.b64_json) {
      images.push({
        src: `data:image/png;base64,${item.b64_json}`,
        revisedPrompt: item.revised_prompt,
      })
    } else if (item.url) {
      images.push({
        src: await urlToDataUrl(item.url),
        revisedPrompt: item.revised_prompt,
      })
    }
  }

  if (images.length === 0) throw new Error('No image returned by upstream')
  return { images }
}

async function parseImageTaskResponse(response: Response, prefix: string) {
  return parseJsonResponse<ImageGenerationTask>(response, prefix)
}

async function waitForImageTask(
  task: ImageGenerationTask,
  onTaskUpdate?: (task: ImageGenerationTask) => void
) {
  let currentTask = task
  let pollingFailures = 0
  onTaskUpdate?.(currentTask)
  while (currentTask.status === 'queued' || currentTask.status === 'running') {
    await delay(currentTask.pollAfterMs || 1500)
    try {
      const response = await fetch(`/api/image-tasks/${encodeURIComponent(currentTask.taskId)}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(currentTask.accessToken ? { 'X-Image-Task-Token': currentTask.accessToken } : {}),
        },
      })
      currentTask = {
        ...(await parseImageTaskResponse(response, 'Image task polling failed')),
        accessToken: currentTask.accessToken,
      }
      pollingFailures = 0
      onTaskUpdate?.(currentTask)
    } catch (error) {
      pollingFailures += 1
      if (pollingFailures >= 8) {
        throw new Error(
          `图片任务仍在后台执行，但浏览器连续无法获取任务状态。请稍后刷新页面查看结果。${error instanceof Error ? ` 原因：${error.message}` : ''}`
        )
      }
    }
  }

  if (currentTask.status !== 'completed') {
    throw new Error(currentTask.error || 'Image generation task failed')
  }
  if (!currentTask.result) {
    throw new Error('Image generation task completed without a result')
  }
  return parseImageResult(currentTask.result)
}

function shouldFallbackImageEdit(error: unknown) {
  return false
}

function fallbackPromptForImageEdit(payload: ImageGenerationPayload, references: ReferenceImage[]) {
  const referenceNames = references.map((image) => image.title || image.name).filter(Boolean)
  if (referenceNames.length === 0) return payload.prompt
  return [
    payload.prompt,
    '',
    `参考图名称：${referenceNames.join('、')}。当前上游图生图接口不可用，请根据提示词中对参考图主体、风格、构图和细节的描述完成文生图降级生成。`,
  ].join('\n')
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (!item || typeof item !== 'object') return ''
        const record = item as Record<string, unknown>
        return (
          extractTextContent(record.text) ||
          extractTextContent(record.content) ||
          extractTextContent(record.value)
        )
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return (
      extractTextContent(record.text) ||
      extractTextContent(record.content) ||
      extractTextContent(record.value)
    )
  }
  return ''
}

function summarizePromptOptimizationResponse(body: unknown) {
  if (!body || typeof body !== 'object') return '空对象'
  const record = body as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const message =
    firstChoice?.message && typeof firstChoice.message === 'object'
      ? (firstChoice.message as Record<string, unknown>)
      : null
  const messageKeys = message ? Object.keys(message).join(',') || '无' : '无 message'
  const outputCount = Array.isArray(record.output) ? record.output.length : 0
  return `choices=${choices.length}, finish_reason=${String(firstChoice?.finish_reason || '无')}, message_keys=${messageKeys}, output=${outputCount}`
}

async function parsePromptOptimizationResult(body: {
  choices?: Array<{
    message?: {
      content?: unknown
      text?: unknown
      refusal?: unknown
      reasoning_content?: unknown
    }
    delta?: { content?: unknown }
    text?: unknown
    finish_reason?: string
  }>
  output_text?: unknown
  output?: unknown
  content?: unknown
  text?: unknown
}) {
  const firstChoice = body.choices?.[0]
  const content =
    extractTextContent(firstChoice?.message?.content) ||
    extractTextContent(firstChoice?.message?.text) ||
    extractTextContent(firstChoice?.delta?.content) ||
    extractTextContent(firstChoice?.text) ||
    extractTextContent(body.output_text) ||
    extractTextContent(body.output) ||
    extractTextContent(body.content) ||
    extractTextContent(body.text)
  const optimizedPrompt = content
    .trim()
    .replace(/^```(?:[\w-]+)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  if (!optimizedPrompt) {
    const refusal = extractTextContent(firstChoice?.message?.refusal)
    if (refusal) throw new Error(`模型拒绝返回优化后的提示词：${refusal}`)
    const reasoning = extractTextContent(firstChoice?.message?.reasoning_content)
    if (reasoning) {
      throw new Error('模型只返回了推理内容，没有返回最终提示词。请重试，或在控制台换一个普通聊天模型。')
    }
    throw new Error(`模型没有返回优化后的提示词（${summarizePromptOptimizationResponse(body)}）`)
  }
  return optimizedPrompt
}

function promptOptimizationRequestBody(payload: PromptOptimizationPayload) {
  return {
    model: payload.model,
    messages: promptOptimizationMessages(payload),
    temperature: 0.6,
    stream: false,
  }
}

function promptOptimizationResponsesRequestBody(payload: PromptOptimizationPayload) {
  return {
    model: payload.model,
    input: promptOptimizationMessages(payload),
    temperature: 0.6,
    stream: false,
  }
}

function promptOptimizationMessages(payload: PromptOptimizationPayload) {
  return buildPromptOptimizationMessages(payload)
}

function negativePromptOptimizationSystemInstruction() {
  return buildNegativePromptOptimizationMessages({
    baseUrl: '',
    apiKey: '',
    model: '',
    prompt: '',
  })[0].content
}

function negativePromptOptimizationUserText(payload: NegativePromptOptimizationPayload) {
  return buildNegativePromptOptimizationMessages(payload)[1].content
}

function negativePromptOptimizationMessages(payload: NegativePromptOptimizationPayload) {
  return [
    {
      role: 'system',
      content: negativePromptOptimizationSystemInstruction(),
    },
    {
      role: 'user',
      content: negativePromptOptimizationUserText(payload),
    },
  ]
}

function negativePromptOptimizationRequestBody(payload: NegativePromptOptimizationPayload) {
  return {
    model: payload.model,
    messages: negativePromptOptimizationMessages(payload),
    temperature: 0.3,
    stream: false,
  }
}

function negativePromptOptimizationResponsesRequestBody(
  payload: NegativePromptOptimizationPayload
) {
  return {
    model: payload.model,
    instructions: negativePromptOptimizationSystemInstruction(),
    input: [
      {
        role: 'user',
        content: negativePromptOptimizationUserText(payload),
      },
    ],
    temperature: 0.3,
    stream: false,
  }
}

function sketchDescriptionSystemInstruction() {
  return '你是资深视觉导演、分镜草图分析师和 AI 图像提示词工程师。你的任务是读取用户手绘草图，提取画面构图和元素位置，并输出一段可直接并入生图提示词的中文构图约束。最终只输出约束正文，不解释过程，不写 Markdown，不使用代码块。'
}

function sketchDescriptionUserText(payload: SketchDescriptionPayload) {
  const prompt = payload.prompt.trim() || '用户未填写文字描述。'
  const sketchWeightInstructions = {
    reference:
      '把草图作为构图参考，提取主体、元素和留白的大致关系；允许最终画面根据用户文字和生成模型审美做自然优化。',
    strict:
      '严格遵循草图中的主体位置、元素大小关系、前中后景、留白和镜头方向；只允许做必要的美化，不要改变版式骨架。',
    layout:
      '只读取草图的布局信息，包括画面比例、主体框架、元素位置、空间层次和留白；忽略草图里的具体风格、材质、身份、文字和情绪。',
  } satisfies Record<NonNullable<SketchDescriptionPayload['sketchWeight']>, string>
  const sketchWeight =
    payload.sketchWeight && sketchWeightInstructions[payload.sketchWeight]
      ? payload.sketchWeight
      : 'reference'
  return `请分析这张用户手绘的分镜/构图草图，并结合用户文字描述，输出适合加入最终生图提示词的“分镜草图约束”。

用户文字描述：
${prompt}

草图权重：
${sketchWeightInstructions[sketchWeight]}

识别要求：
1. 重点描述画面比例、主体位置、前中后景关系、留白区域、元素大小关系、运动/视线方向、镜头角度和构图节奏。
2. 如果草图里有多个框、箭头、文字标记或占位块，请解释它们在画面中的大致作用和位置。
3. 不要把草图的粗糙线条当成最终风格；只把它作为导演分镜和版式参考。
4. 不要编造草图中不存在的具体品牌、文字、价格、二维码或人物身份。
5. 输出 120 到 320 个中文字符，以“分镜草图约束：”开头。`
}

function sketchDescriptionMessages(payload: SketchDescriptionPayload) {
  return [
    {
      role: 'system',
      content: sketchDescriptionSystemInstruction(),
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: sketchDescriptionUserText(payload),
        },
        {
          type: 'image_url',
          image_url: { url: payload.sketchDataUrl },
        },
      ],
    },
  ]
}

function sketchDescriptionRequestBody(payload: SketchDescriptionPayload) {
  return {
    model: payload.model,
    messages: sketchDescriptionMessages(payload),
    temperature: 0.2,
    stream: false,
  }
}

function sketchDescriptionResponsesRequestBody(payload: SketchDescriptionPayload) {
  return {
    model: payload.model,
    instructions: sketchDescriptionSystemInstruction(),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: sketchDescriptionUserText(payload),
          },
          {
            type: 'input_image',
            image_url: payload.sketchDataUrl,
          },
        ],
      },
    ],
    temperature: 0.2,
    stream: false,
  }
}

function commerceMainPromptSystemInstruction() {
  return buildCommerceMainPromptSystemInstruction()
}

function commerceMainPromptUserText(payload: CommerceMainPromptPayload) {
  return buildCommerceMainPromptUserText(payload)
}

function commerceMainPromptMessages(payload: CommerceMainPromptPayload) {
  return [
    {
      role: 'system',
      content: commerceMainPromptSystemInstruction(),
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: commerceMainPromptUserText(payload),
        },
        ...payload.productImages.map((image) => ({
          type: 'image_url',
          image_url: { url: image.dataUrl },
        })),
        {
          type: 'image_url',
          image_url: { url: payload.styleImage.dataUrl },
        },
      ],
    },
  ]
}

function commerceMainPromptRequestBody(payload: CommerceMainPromptPayload) {
  return {
    model: payload.model,
    messages: commerceMainPromptMessages(payload),
    temperature: 0.4,
    stream: false,
  }
}

function commerceMainPromptResponsesRequestBody(payload: CommerceMainPromptPayload) {
  return {
    model: payload.model,
    instructions: commerceMainPromptSystemInstruction(),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: commerceMainPromptUserText(payload),
          },
          ...payload.productImages.map((image) => ({
            type: 'input_image',
            image_url: image.dataUrl,
          })),
          {
            type: 'input_image',
            image_url: payload.styleImage.dataUrl,
          },
        ],
      },
    ],
    temperature: 0.4,
    stream: false,
  }
}

function commerceDetailPromptSystemInstruction() {
  return buildCommerceDetailPromptSystemInstruction()
}

function commerceDetailPromptUserText(payload: CommerceDetailPromptPayload) {
  return buildCommerceDetailPromptUserText(payload)
}

function commerceDetailPromptMessages(payload: CommerceDetailPromptPayload) {
  return [
    {
      role: 'system',
      content: commerceDetailPromptSystemInstruction(),
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: commerceDetailPromptUserText(payload),
        },
        ...payload.productImages.map((image) => ({
          type: 'image_url',
          image_url: { url: image.dataUrl },
        })),
        {
          type: 'image_url',
          image_url: { url: payload.styleImage.dataUrl },
        },
      ],
    },
  ]
}

function commerceDetailPromptRequestBody(payload: CommerceDetailPromptPayload) {
  return {
    model: payload.model,
    messages: commerceDetailPromptMessages(payload),
    temperature: 0.4,
    stream: false,
  }
}

function commerceDetailPromptResponsesRequestBody(payload: CommerceDetailPromptPayload) {
  return {
    model: payload.model,
    instructions: commerceDetailPromptSystemInstruction(),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: commerceDetailPromptUserText(payload),
          },
          ...payload.productImages.map((image) => ({
            type: 'input_image',
            image_url: image.dataUrl,
          })),
          {
            type: 'input_image',
            image_url: payload.styleImage.dataUrl,
          },
        ],
      },
    ],
    temperature: 0.4,
    stream: false,
  }
}

export const bridge: ImageApiClient = {
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },

  async loginNewApi(payload) {
    return obtainManagedNewApiKey(payload)
  },

  async listModels(args) {
    const response = await fetch(openAiProxyUrl(args.baseUrl, '/v1/models'), {
      method: 'GET',
      headers: headers(args.apiKey),
    })
    const body = await parseJsonResponse<{ data?: ModelOption[] }>(
      response,
      'Failed to fetch models'
    )
    return (body.data || []).filter((model) => model.id)
  },

  async optimizePrompt(payload) {
    const response = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify(promptOptimizationRequestBody(payload)),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
    }>(response, 'Prompt optimization failed')
    try {
      return await parsePromptOptimizationResult(body)
    } catch (error) {
      if (!isEmptyPromptOptimizationError(error)) throw error
      const chatErrorMessage = error instanceof Error ? error.message : String(error)

      const fallbackResponse = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify(promptOptimizationResponsesRequestBody(payload)),
      })
      const fallbackBody = await parseJsonResponse<{
        choices?: Array<{ message?: { content?: string }; text?: string }>
        output_text?: unknown
        output?: unknown
        content?: unknown
        text?: unknown
      }>(fallbackResponse, 'Prompt optimization fallback failed')
      try {
        return await parsePromptOptimizationResult(fallbackBody)
      } catch (fallbackError) {
        if (isEmptyPromptOptimizationError(fallbackError)) {
          throw new Error(
            `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；chat/completions 也返回空结果：${chatErrorMessage}`
          )
        }
        throw fallbackError
      }
    }
  },

  async optimizeNegativePrompt(payload) {
    const response = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify(negativePromptOptimizationRequestBody(payload)),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
    }>(response, 'Negative prompt optimization failed')
    try {
      return await parsePromptOptimizationResult(body)
    } catch (error) {
      if (!isEmptyPromptOptimizationError(error)) throw error
      const chatErrorMessage = error instanceof Error ? error.message : String(error)

      const fallbackResponse = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify(negativePromptOptimizationResponsesRequestBody(payload)),
      })
      const fallbackBody = await parseJsonResponse<{
        choices?: Array<{ message?: { content?: string }; text?: string }>
        output_text?: unknown
        output?: unknown
        content?: unknown
        text?: unknown
      }>(fallbackResponse, 'Negative prompt optimization fallback failed')
      try {
        return await parsePromptOptimizationResult(fallbackBody)
      } catch (fallbackError) {
        if (isEmptyPromptOptimizationError(fallbackError)) {
          throw new Error(
            `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；chat/completions 也返回空结果：${chatErrorMessage}`
          )
        }
        throw fallbackError
      }
    }
  },

  async describeSketch(payload) {
    const response = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify(sketchDescriptionRequestBody(payload)),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
      output_text?: unknown
      output?: unknown
      content?: unknown
      text?: unknown
    }>(response, 'Sketch description failed')
    try {
      return await parsePromptOptimizationResult(body)
    } catch (error) {
      if (!isEmptyPromptOptimizationError(error)) throw error
      const chatErrorMessage = error instanceof Error ? error.message : String(error)

      const fallbackResponse = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify(sketchDescriptionResponsesRequestBody(payload)),
      })
      const fallbackBody = await parseJsonResponse<{
        choices?: Array<{ message?: { content?: string }; text?: string }>
        output_text?: unknown
        output?: unknown
        content?: unknown
        text?: unknown
      }>(fallbackResponse, 'Sketch description fallback failed')
      try {
        return await parsePromptOptimizationResult(fallbackBody)
      } catch (fallbackError) {
        if (isEmptyPromptOptimizationError(fallbackError)) {
          throw new Error(
            `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；chat/completions 也返回空结果：${chatErrorMessage}`
          )
        }
        throw fallbackError
      }
    }
  },

  async prepareCommerceMainPrompt(payload) {
    const response = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify(commerceMainPromptRequestBody(payload)),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
      output_text?: unknown
      output?: unknown
      content?: unknown
      text?: unknown
    }>(response, 'Commerce prompt preparation failed')
    try {
      return await parsePromptOptimizationResult(body)
    } catch (error) {
      if (!isEmptyPromptOptimizationError(error)) throw error
      const chatErrorMessage = error instanceof Error ? error.message : String(error)

      const fallbackResponse = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify(commerceMainPromptResponsesRequestBody(payload)),
      })
      const fallbackBody = await parseJsonResponse<{
        choices?: Array<{ message?: { content?: string }; text?: string }>
        output_text?: unknown
        output?: unknown
        content?: unknown
        text?: unknown
      }>(fallbackResponse, 'Commerce prompt preparation fallback failed')
      try {
        return await parsePromptOptimizationResult(fallbackBody)
      } catch (fallbackError) {
        if (isEmptyPromptOptimizationError(fallbackError)) {
          throw new Error(
            `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；chat/completions 也返回空结果：${chatErrorMessage}`
          )
        }
        throw fallbackError
      }
    }
  },

  async prepareCommerceDetailPrompt(payload) {
    const response = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify(commerceDetailPromptRequestBody(payload)),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
      output_text?: unknown
      output?: unknown
      content?: unknown
      text?: unknown
    }>(response, 'Commerce detail prompt preparation failed')
    try {
      return await parsePromptOptimizationResult(body)
    } catch (error) {
      if (!isEmptyPromptOptimizationError(error)) throw error
      const chatErrorMessage = error instanceof Error ? error.message : String(error)

      const fallbackResponse = await fetch(openAiProxyUrl(payload.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify(commerceDetailPromptResponsesRequestBody(payload)),
      })
      const fallbackBody = await parseJsonResponse<{
        choices?: Array<{ message?: { content?: string }; text?: string }>
        output_text?: unknown
        output?: unknown
        content?: unknown
        text?: unknown
      }>(fallbackResponse, 'Commerce detail prompt preparation fallback failed')
      try {
        return await parsePromptOptimizationResult(fallbackBody)
      } catch (fallbackError) {
        if (isEmptyPromptOptimizationError(fallbackError)) {
          throw new Error(
            `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}；chat/completions 也返回空结果：${chatErrorMessage}`
          )
        }
        throw fallbackError
      }
    }
  },

  async listStyles() {
    const response = await fetch('./style-library/index.json', { cache: 'force-cache' })
    return parseJsonResponse<StyleLibraryResult>(response, 'Style library failed')
  },

  async listStyleCategory(category: StyleCategory) {
    if (!category.href) {
      throw new Error(`风格分类缺少静态资源路径：${category.name}`)
    }
    const response = await fetch(category.href, { cache: 'force-cache' })
    return parseJsonResponse<StyleCategoryResult>(response, 'Style category failed')
  },

  async getImageTask(taskId) {
    const response = await fetch(`/api/image-tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    return parseImageTaskResponse(response, 'Image task fetch failed')
  },

  async listImageTasks() {
    return []
  },

  async generateImages(payload: ImageGenerationPayload) {
    const startedAt = Date.now()
    const taskId = `local-${startedAt}-${Math.random().toString(36).slice(2, 10)}`
    payload.onTaskUpdate?.({
      taskId,
      status: 'running',
      createdAt: startedAt,
      updatedAt: startedAt,
      pollAfterMs: 0,
    })

    if (payload.mode === 'image') {
      const rawReferences = payload.referenceImages || []
      if (rawReferences.length === 0) {
        throw new Error('At least one reference image is required')
      }
      const references = await normalizeImageEditReferences(rawReferences, payload.model)

      const apiSize = normalizedImageApiSize(payload.model, payload.size)
      const fields: Record<string, string> = {
        model: payload.model,
        prompt: payload.prompt,
        size: apiSize,
        n: String(payload.count),
      }
      if (shouldSendImageResponseFormat(payload.model, payload.responseFormat)) {
        fields.response_format = payload.responseFormat
      }
      if (payload.quality !== 'auto') {
        fields.quality = payload.quality
      }
      if (payload.inputFidelity && payload.model.trim().toLowerCase() !== 'gpt-image-2') {
        fields.input_fidelity = payload.inputFidelity
      }

      try {
        const response = await fetch('/api/image-tasks', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            request: {
              prompt: payload.prompt,
              model: payload.model,
              size: payload.size,
              quality: payload.quality,
              mode: 'image',
              responseFormat: payload.responseFormat,
              count: payload.count,
              retryCount: normalizeRetryCount(payload.retryCount),
              referenceImageNames: references.map((image) => image.title || image.name),
            },
            upstream: {
              kind: 'multipart',
              baseUrl: payload.baseUrl,
              apiKey: payload.apiKey,
              path: '/v1/images/edits',
              fields,
              images: references.map((image) => ({
                name: image.name,
                dataUrl: image.dataUrl,
              })),
            },
            billing: imageTaskBilling(payload),
          }),
        })
        const createdTask = await parseImageTaskResponse(response, 'Image edit task failed')
        return await waitForImageTask(createdTask, payload.onTaskUpdate)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const imageEditMessage = `图生图失败：上游没有成功处理参考图，不能降级为文生图，否则会丢失参考图主体。${message}`
        payload.onTaskUpdate?.({
          taskId,
          status: 'failed',
          createdAt: startedAt,
          updatedAt: Date.now(),
          completedAt: Date.now(),
          error: imageEditMessage,
          pollAfterMs: 0,
        })
        throw new Error(imageEditMessage)
      }
    }

    const requestedCount = Math.max(1, Math.floor(payload.count))
    const apiSize = normalizedImageApiSize(payload.model, payload.size)
    const images: ImageGenerationResult['images'] = []

    try {
      for (let index = 0; index < requestedCount; index += 1) {
        const response = await fetch('/api/image-tasks', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            request: {
              prompt: payload.prompt,
              model: payload.model,
              size: payload.size,
              quality: payload.quality,
              mode: 'text',
              responseFormat: payload.responseFormat,
              count: 1,
              retryCount: normalizeRetryCount(payload.retryCount),
            },
            upstream: {
              kind: 'json',
              baseUrl: payload.baseUrl,
              apiKey: payload.apiKey,
              path: '/v1/images/generations',
              body: {
                model: payload.model,
                prompt: payload.prompt,
                size: apiSize,
                ...(payload.quality !== 'auto' ? { quality: payload.quality } : {}),
                n: 1,
                ...(shouldSendImageResponseFormat(payload.model, payload.responseFormat)
                  ? { response_format: payload.responseFormat }
                  : {}),
              },
            },
            billing: imageTaskBilling(payload),
          }),
        })
        const createdTask = await parseImageTaskResponse(response, 'Image generation task failed')
        const parsed = await waitForImageTask(createdTask, (task) => {
          payload.onTaskUpdate?.({
            ...task,
            error:
              task.error ||
              (task.status === 'running' && requestedCount > 1
                ? `正在生成第 ${index + 1}/${requestedCount} 张`
                : task.error),
          })
        })
        images.push(...parsed.images)
      }
      payload.onTaskUpdate?.({
        taskId,
        status: 'completed',
        createdAt: startedAt,
        updatedAt: Date.now(),
        completedAt: Date.now(),
        result: { data: [] },
        pollAfterMs: 0,
      })
      return { images }
    } catch (error) {
      payload.onTaskUpdate?.({
        taskId,
        status: 'failed',
        createdAt: startedAt,
        updatedAt: Date.now(),
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        pollAfterMs: 0,
      })
      throw error
    }
  },
}
