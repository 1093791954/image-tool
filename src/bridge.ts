import type {
  CommerceMainPromptPayload,
  ImageApiClient,
  ImageGenerationPayload,
  ImageGenerationResult,
  ImageGenerationTask,
  ManagedNewApiLoginResult,
  ModelOption,
  PromptOptimizationPayload,
  PromptOptimizationPreset,
  StyleLibraryResult,
} from './types'

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
    throw new Error(`${prefix}: ${message}`)
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
    throw new Error(body?.message || fallback)
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
    throw new Error(task.error || '服务器后台生图任务失败')
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

const promptPresetMagic: Record<PromptOptimizationPreset, { label: string; instruction: string }> = {
  general: {
    label: '通用增强',
    instruction:
      '按通用高质量图像生成要求增强：明确主体、画面层次、构图、材质、光线、镜头语言、风格和画质，不额外添加营销话术。',
  },
  ecommerce: {
    label: '电商卖货',
    instruction:
      '加入电商转化导向：突出商品主体和核心卖点，强化详情页/主图可用的干净构图、质感、消费场景、利益点氛围、真实材质和高级棚拍光线；避免要求模型生成不可控的长文字。',
  },
  product: {
    label: '产品质感',
    instruction:
      '加入产品摄影魔法：强调材质纹理、边缘高光、反射控制、微距细节、干净背景、商业棚拍、真实阴影和高级质感，让主体适合被清楚检视。',
  },
  social: {
    label: '社媒爆款',
    instruction:
      '加入社媒传播魔法：强化第一眼吸引力、强对比主视觉、情绪氛围、生活方式场景、封面感构图、节奏感和平台内容审美，但保持画面干净。',
  },
  brand: {
    label: '品牌海报',
    instruction:
      '加入品牌视觉魔法：强调品牌调性、主视觉秩序、留白、视觉层级、色彩系统、海报级构图、精致光影和可用于品牌 Campaign 的高级感。',
  },
  character: {
    label: 'IP/角色',
    instruction:
      '加入角色/IP 魔法：强化角色辨识度、表情、姿态、服装细节、世界观氛围、动作叙事和一致性；不要改变用户指定的角色核心特征。',
  },
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
  const modeLabel = payload.mode === 'image' ? '图像参考生成' : '文生图'
  const magic = promptPresetMagic[payload.optimizationPreset] || promptPresetMagic.general
  return [
    {
      role: 'system',
      content:
        '你是资深 AI 图像提示词导演和商业视觉修辞编辑。你的任务是先在内部判断用户真正想生成什么，再把原始提示词扩写为稳定、清晰、可执行的中文生图提示词。你必须保留用户原意、主体、场景、指定文字、品牌/产品/人物特征和关键限制；只补足缺失的视觉变量，不做无关发挥。最终只输出优化后的提示词正文，不解释过程，不添加寒暄，不使用代码块。',
    },
    {
      role: 'user',
      content: `任务类型：${modeLabel}
优化方向：${magic.label}
方向要求：${magic.instruction}

请把下面的中文图像生成提示词优化得更具体、更适合高质量图像生成。请在内部完成这些判断，但不要输出分析过程：
1. 判断用户要生成的主体、用途、画面类型和必须保留的信息。
2. 补全主体形态、构图、镜头、背景、材质、光线、色彩、风格、画质、负面约束。
3. 如果用户要求画面中出现某段文字、网址、Logo 或标识，必须在【画面文字】里原样保留，不要把它放进负面约束，也不要改写大小写、符号或引号内内容。
4. 如果用户没有要求画面出现文字，请在【画面文字】写“无文字、无 Logo、无水印”。
5. 不要编造用户没提到的品牌、IP、人物身份、国家地区、价格、参数、按钮、二维码或平台界面。
6. 输出应适合直接复制到图像生成模型，不要出现“可以”“建议”“应该”等说明口吻。

输出固定使用以下 8 个小标题，每个小标题下写 1 到 2 句完整提示词，总体控制在 350 到 800 个中文字符：

【主体与目标】
明确主体是什么、视觉目标是什么、哪些原始信息必须保持。

【构图镜头】
明确景别、视角、主体位置、画面层次、焦段/镜头感和空间关系。

【场景背景】
明确背景、道具、环境氛围和留白，背景服务主体，不喧宾夺主。

【材质细节】
明确材质、纹理、边缘、高光、反射、精修细节和真实感。

【光线色彩】
明确主光、辅光、阴影、色彩倾向、对比度、冷暖关系和层次。

【风格画质】
明确摄影/插画/海报/3D 等风格、渲染质感、清晰度和商业完成度。

【画面文字】
只描述用户明确要求出现的文字、位置和样式；没有文字要求则写“无文字、无 Logo、无水印”。

【负面约束】
列出需要避免的问题：低清、模糊、噪点、畸变、比例失衡、过度复杂背景、错误肢体、错误文字、无关水印等；不要否定用户明确要求保留的内容。

原提示词：${payload.prompt}`,
    },
  ]
}

function commerceMainPromptSystemInstruction() {
  return '你是资深电商主图视觉导演、商业修图提示词工程师和多模态图像分析师。你的任务是分析商品白底图和目标风格图，然后输出一段可直接用于图像编辑/图像参考生成模型的中文提示词。最终只输出提示词正文，不解释过程，不写 Markdown，不使用代码块。'
}

function commerceMainPromptUserText(payload: CommerceMainPromptPayload) {
  const description = payload.description.trim() || '用户未填写额外文字描述。'
  return `请完成电商主图提示词预处理：

输入说明：
1. 前 ${Math.max(1, payload.productImages.length)} 张图是【商品白底图】，可能包含同一个商品的多个角度，是必须保留的商品主体依据。
2. 最后一张图是【目标风格图】，是构图、背景、光线、色彩、文字布局和商业氛围的参考图。
3. 用户文字描述可能很少，也可能很多；请结合目标风格图进行修剪，只保留适合画面出现或影响视觉表达的信息。

用户文字描述：
${description}

内部分析要求，不要输出分析过程：
1. 识别目标风格图的构图、主体位置、背景层次、光线方向、材质质感、色彩倾向、摄影/设计风格。
2. 识别目标风格图中可见的文字数量、位置、层级、排版方式和大致用途；如果用户文字描述里有适合替换到画面中的文案，则选择性替换目标风格图的文字；如果用户没有给明确可上图文字，则要求去除/弱化风格图文字，不要编造品牌、价格、参数、二维码。
3. 最终提示词必须明确：综合多张商品白底图理解同一商品的外观、结构和多角度细节，用该商品替换目标风格图里的主商品/主物体，同时保留商品真实外观、结构、颜色、材质、比例和关键细节。
4. 目标风格图只迁移构图、背景、光线、色彩、视觉层级、文字版式和商业质感，不复制风格图中的商品品牌或无关元素。
5. 输出提示词应适合图像编辑模型，强调“参考两张图完成商品替换和风格迁移”。

输出结构必须包含这些段落标题：
【核心任务】
【商品保持】
【风格迁移】
【文字处理】
【构图光线】
【画质要求】
【负面约束】

总体控制在 450 到 900 个中文字符。`
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

      const form = new FormData()
      form.set('model', payload.model)
      form.set('prompt', payload.prompt)
      form.set('size', payload.size)
      form.set('quality', payload.quality)
      form.set('n', String(payload.count))
      form.set('response_format', payload.responseFormat)
      if (payload.inputFidelity) {
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

    const response = await fetch(openAiImageProxyUrl('generations', payload.baseUrl), {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify({
        model: payload.model,
        prompt: payload.prompt,
        size: payload.size,
        quality: payload.quality,
        n: payload.count,
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

    return parseImageResult(result)
  },
}
