import type {
  ImageApiClient,
  ImageGenerationPayload,
  ImageGenerationResult,
  ManagedNewApiLoginResult,
  ModelOption,
  PromptOptimizationPayload,
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
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText
    throw new Error(`${prefix}: ${message}`)
  }

  return body as T
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
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`)
  const blob = await response.blob()

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

function promptOptimizationMessages(payload: PromptOptimizationPayload) {
  const modeLabel = payload.mode === 'image' ? '图像参考生成' : '文生图'
  return [
    {
      role: 'system',
      content:
        '你是专业的 AI 图像提示词编辑器。只输出优化后的提示词本身，不要解释，不要加标题，不要使用 Markdown。',
    },
    {
      role: 'user',
      content: `任务类型：${modeLabel}\n请把下面的中文图像生成提示词优化得更具体、更适合商业海报和高质量图像生成。保留用户原意，补足主体、构图、材质、光线、风格、画质要求。不要改变为英文。\n\n原提示词：${payload.prompt}`,
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

      const response = await fetch(`${normalizeBaseUrl(payload.baseUrl)}/v1/images/edits`, {
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

    const response = await fetch(
      `${normalizeBaseUrl(payload.baseUrl)}/v1/images/generations`,
      {
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
      }
    )
    const body = await parseJsonResponse<{
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
    }>(response, 'Image generation failed')

    return parseImageResult(body)
  },
}
