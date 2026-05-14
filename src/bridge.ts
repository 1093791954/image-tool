import type {
  AppSettings,
  ImageGenerationPayload,
  ImageGenerationResult,
  ImageToolsBridge,
  ModelOption,
} from './types'

const settingsKey = 'image-tools-settings'

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

const webBridge: ImageToolsBridge = {
  async getSettings() {
    const raw = localStorage.getItem(settingsKey)
    if (!raw) {
      return {
        baseUrl: 'https://cc.api-corp.top',
        persistApiKey: false,
        apiKey: '',
        themeMode: 'system',
        galleryDir: '',
      }
    }
    return JSON.parse(raw) as AppSettings
  },

  async saveSettings(settings) {
    const saved = {
      ...settings,
      apiKey: settings.persistApiKey ? settings.apiKey || '' : '',
    }
    localStorage.setItem(settingsKey, JSON.stringify(saved))
    return saved
  },

  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },

  async chooseGalleryDir() {
    return null
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

  async generateImages(payload: ImageGenerationPayload) {
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
  },
}

export const bridge = window.imageTools || webBridge
