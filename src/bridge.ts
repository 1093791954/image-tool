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
  SketchDescriptionPayload,
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

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Base URL is required')
  return trimmed
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
  return (
    source
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240) || normalized.slice(0, 240)
  )
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

function openAiImageProxyUrl(path: 'generations' | 'edits', baseUrl: string) {
  return `/api/openai/v1/images/${path}?base_url=${encodeURIComponent(normalizeBaseUrl(baseUrl))}`
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function assertTaskResponse(
  body: { success?: boolean; message?: string; data?: ImageGenerationTask },
  fallback: string
) {
  return assertApiSuccess(body, fallback)
}

async function waitForImageTask(
  firstTask: ImageGenerationTask,
  onTaskUpdate?: (task: ImageGenerationTask) => void
) {
  let task = firstTask
  onTaskUpdate?.(task)

  while (task.status === 'queued' || task.status === 'running') {
    await delay(Math.max(800, task.pollAfterMs || 1500))
    const response = await fetch(`/api/openai/tasks/${encodeURIComponent(task.taskId)}`)
    const body = await parseJsonResponse<{
      success?: boolean
      message?: string
      data?: ImageGenerationTask
    }>(response, 'Image task polling failed')
    task = assertTaskResponse(body, '查询生图任务失败')
    onTaskUpdate?.(task)
  }

  if (task.status === 'failed' || task.status === 'expired') {
    throw new Error(cleanErrorMessage(task.error || '服务器后台生图任务失败'))
  }
  if (task.status !== 'completed' || !task.result) {
    throw new Error('服务器后台任务没有返回生成结果')
  }
  return task.result
}

async function urlToDataUrl(url: string) {
  let blob: Blob
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`)
    blob = await response.blob()
  } catch {
    const response = await fetch('/api/image-url-to-data-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const body = await parseJsonResponse<{ success?: boolean; message?: string; dataUrl?: string }>(
      response,
      'Image URL proxy failed'
    )
    if (!body.success || !body.dataUrl) {
      throw new Error(body.message || '图片已生成，但浏览器无法下载返回的图片 URL')
    }
    return body.dataUrl
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function blobFromDataUrl(dataUrl: string) {
  const [header, base64] = dataUrl.split(',')
  const type = header.match(/^data:([^;]+);base64$/)?.[1] || 'image/png'
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type })
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
    const response = await fetch('/api/newapi/login-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await parseJsonResponse<{
      success: boolean
      message?: string
      data?: ManagedNewApiLoginResult
    }>(response, 'New API login failed')
    return assertApiSuccess(body, '中转站登录失败')
  },

  async listModels(args) {
    const response = await fetch(`${normalizeBaseUrl(args.baseUrl)}/v1/models`, {
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

      const fallbackResponse = await fetch(`${baseUrl}/v1/responses`, {
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

      const fallbackResponse = await fetch(`${baseUrl}/v1/responses`, {
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

      const fallbackResponse = await fetch(`${baseUrl}/v1/responses`, {
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

      const fallbackResponse = await fetch(`${baseUrl}/v1/responses`, {
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

      const fallbackResponse = await fetch(`${baseUrl}/v1/responses`, {
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
    const response = await fetch('/api/style-library')
    const body = await parseJsonResponse<{
      success?: boolean
      message?: string
      data?: StyleLibraryResult
    }>(response, 'Style library failed')
    return assertApiSuccess(body, '读取风格库失败')
  },

  async generateImages(payload: ImageGenerationPayload) {
    if (payload.mode === 'image') {
      const references = payload.referenceImages || []
      if (references.length === 0) {
        throw new Error('At least one reference image is required')
      }

      const apiSize = normalizedImageApiSize(payload.model, payload.size)
      const form = new FormData()
      form.set('model', payload.model)
      form.set('prompt', payload.prompt)
      form.set('size', apiSize)
      if (payload.quality !== 'auto') {
        form.set('quality', payload.quality)
      }
      form.set('n', String(payload.count))
      form.set('response_format', payload.responseFormat)
      if (payload.inputFidelity && payload.model.trim().toLowerCase() !== 'gpt-image-2') {
        form.set('input_fidelity', payload.inputFidelity)
      }
      references.forEach((image) => {
        form.append('image[]', blobFromDataUrl(image.dataUrl), image.name)
      })

      const response = await fetch(openAiImageProxyUrl('edits', payload.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${payload.apiKey.trim()}`,
        },
        body: form,
      })
      const body = await parseJsonResponse<{
        success?: boolean
        message?: string
        data?: ImageGenerationTask
      }>(response, 'Image edit failed')
      const task = assertTaskResponse(body, '提交图像参考生成任务失败')
      const result = await waitForImageTask(task, payload.onTaskUpdate)

      return parseImageResult(result)
    }

    const requestedCount = Math.max(1, Math.floor(payload.count))
    const apiSize = normalizedImageApiSize(payload.model, payload.size)
    const images: ImageGenerationResult['images'] = []
    for (let index = 0; index < requestedCount; index += 1) {
      const response = await fetch(openAiImageProxyUrl('generations', payload.baseUrl), {
        method: 'POST',
        headers: headers(payload.apiKey),
        body: JSON.stringify({
          model: payload.model,
          prompt: payload.prompt,
          size: apiSize,
          ...(payload.quality !== 'auto' ? { quality: payload.quality } : {}),
          n: 1,
          response_format: payload.responseFormat,
        }),
      })
      const body = await parseJsonResponse<{
        success?: boolean
        message?: string
        data?: ImageGenerationTask
      }>(response, 'Image generation failed')
      const task = assertTaskResponse(body, '提交生图任务失败')
      const result = await waitForImageTask(task, payload.onTaskUpdate)
      const parsed = await parseImageResult(result)
      images.push(...parsed.images)
    }

    return { images }
  },
}
