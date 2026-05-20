import type {
  ImageApiClient,
  ImageGenerationPayload,
  ImageGenerationResult,
  ManagedNewApiLoginResult,
  ModelOption,
  PromptOptimizationPayload,
  PromptOptimizationPreset,
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
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

async function parseJsonResponse<T>(response: Response, prefix: string) {
  const text = await response.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${prefix}: upstream returned invalid JSON`)
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

async function parsePromptOptimizationResult(body: {
  choices?: Array<{ message?: { content?: string }; text?: string }>
}) {
  const content = body.choices?.[0]?.message?.content || body.choices?.[0]?.text || ''
  const optimizedPrompt = content.trim()
  if (!optimizedPrompt) throw new Error('模型没有返回优化后的提示词')
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

function promptOptimizationMessages(payload: PromptOptimizationPayload) {
  const modeLabel = payload.mode === 'image' ? '图像参考生成' : '文生图'
  const magic = promptPresetMagic[payload.optimizationPreset] || promptPresetMagic.general
  return [
    {
      role: 'system',
      content:
        '你是专业的 AI 图像提示词编辑器。只输出优化后的提示词本身，不要解释，不要加标题，不要使用 Markdown。',
    },
    {
      role: 'user',
      content: `任务类型：${modeLabel}\n优化方向：${magic.label}\n方向魔法：${magic.instruction}\n请把下面的中文图像生成提示词优化得更具体、更适合高质量图像生成。保留用户原意，补足主体、构图、材质、光线、风格、画质要求。不要改变为英文。\n\n原提示词：${payload.prompt}`,
    },
  ]
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
    const response = await fetch(`${normalizeBaseUrl(payload.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(payload.apiKey),
      body: JSON.stringify({
        model: payload.model,
        messages: promptOptimizationMessages(payload),
        temperature: 0.6,
      }),
    })
    const body = await parseJsonResponse<{
      choices?: Array<{ message?: { content?: string }; text?: string }>
    }>(response, 'Prompt optimization failed')
    return parsePromptOptimizationResult(body)
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
        data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
      }>(response, 'Image edit failed')

      return parseImageResult(body)
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
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
    }>(response, 'Image generation failed')

    return parseImageResult(body)
  },
}
