import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } from 'electron'
import type { OpenDialogOptions } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AppSettings,
  GeneratedImage,
  ImageGenerationPayload,
  ImageGenerationResult,
  LocalImageRecord,
  ModelOption,
} from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = !app.isPackaged
const SHOP_URL = 'https://pay.ldxp.cn/shop/LY6AR08H'
const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://cc.api-corp.top',
  persistApiKey: false,
  apiKey: '',
  themeMode: 'system',
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

function appRootDir() {
  return isDev ? path.resolve(__dirname, '..') : path.dirname(process.execPath)
}

function dataDir() {
  return path.join(appRootDir(), 'image-tools-data')
}

function settingsPath() {
  return path.join(dataDir(), 'settings.json')
}

function galleryIndexPath() {
  return path.join(dataDir(), 'gallery.json')
}

function defaultGalleryDir() {
  return path.join(dataDir(), 'images')
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function readSettings(): Promise<AppSettings> {
  const settings = await readJsonFile<AppSettings>(settingsPath(), DEFAULT_SETTINGS)
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    galleryDir: settings.galleryDir || defaultGalleryDir(),
  }
}

async function saveSettings(settings: AppSettings) {
  const nextSettings: AppSettings = {
    baseUrl: settings.baseUrl || DEFAULT_SETTINGS.baseUrl,
    persistApiKey: Boolean(settings.persistApiKey),
    apiKey: settings.persistApiKey ? settings.apiKey || '' : '',
    themeMode: settings.themeMode || 'system',
    galleryDir: settings.galleryDir || defaultGalleryDir(),
  }
  await writeJsonFile(settingsPath(), nextSettings)
  await ensureDir(nextSettings.galleryDir || defaultGalleryDir())
  return nextSettings
}

async function readGallery() {
  const records = await readJsonFile<LocalImageRecord[]>(galleryIndexPath(), [])
  return records.sort((a, b) => b.createdAt - a.createdAt)
}

async function writeGallery(records: LocalImageRecord[]) {
  await writeJsonFile(galleryIndexPath(), records.sort((a, b) => b.createdAt - a.createdAt))
}

function extensionFromDataUrl(src: string) {
  const match = src.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/)
  if (!match) return 'png'
  if (match[1] === 'jpeg') return 'jpg'
  if (match[1] === 'svg+xml') return 'svg'
  return match[1].toLowerCase()
}

function bufferFromDataUrl(src: string) {
  const match = src.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Only base64 data URL images can be saved locally')
  return Buffer.from(match[2], 'base64')
}

async function saveLocalImages(records: LocalImageRecord[]) {
  const settings = await readSettings()
  const galleryDir = settings.galleryDir || defaultGalleryDir()
  await ensureDir(galleryDir)

  const existing = await readGallery()
  const savedRecords: LocalImageRecord[] = []

  for (const record of records) {
    const ext = extensionFromDataUrl(record.src)
    const filename = `gpt-image-${record.createdAt}-${record.id.replace(/[^a-zA-Z0-9-]/g, '-')}.${ext}`
    const filePath = path.join(galleryDir, filename)
    await fs.writeFile(filePath, bufferFromDataUrl(record.src))
    savedRecords.push({
      ...record,
      filePath,
      filename,
      src: `file://${filePath.replace(/\\/g, '/')}`,
    })
  }

  await writeGallery([...savedRecords, ...existing])
  return savedRecords
}

function resolveUrl(baseUrl: string, endpoint: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Base URL is required')
  return `${trimmed}${endpoint}`
}

function authHeaders(apiKey: string) {
  const key = apiKey.trim()
  if (!key) throw new Error('API Key is required')
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  errorPrefix: string
): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()

  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null
        ? ((body as { error?: { message?: string }; message?: string }).error
            ?.message ?? (body as { message?: string }).message)
        : String(body || response.statusText)
    throw new Error(`${errorPrefix}: ${message || response.statusText}`)
  }

  return body as T
}

async function downloadAsDataUrl(url: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || 'image/png'
  const arrayBuffer = await response.arrayBuffer()
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return `data:${contentType};base64,${base64}`
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: 'GPT Image Tools',
    backgroundColor: '#f7f7f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function createTray() {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('GPT Image Tools')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        },
      },
      {
        label: '退出',
        click: () => {
          app.isQuiting = true
          app.quit()
        },
      },
    ])
  )
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

ipcMain.handle('settings:get', () => readSettings())

ipcMain.handle('settings:save', (_event, settings: AppSettings) =>
  saveSettings(settings)
)

ipcMain.handle('external:open', async (_event, url: string) => {
  if (url !== SHOP_URL) {
    throw new Error('External URL is not allowed')
  }
  await shell.openExternal(url)
})

ipcMain.handle('images:list-local', () => readGallery())

ipcMain.handle('images:save-local', (_event, records: LocalImageRecord[]) =>
  saveLocalImages(records)
)

ipcMain.handle('images:delete-local', async (_event, id: string) => {
  const records = await readGallery()
  const target = records.find((record) => record.id === id)
  if (target?.filePath) {
    await fs.unlink(target.filePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }
  await writeGallery(records.filter((record) => record.id !== id))
})

ipcMain.handle('images:clear-local', async () => {
  const records = await readGallery()
  for (const record of records) {
    if (!record.filePath) continue
    await fs.unlink(record.filePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }
  await writeGallery([])
})

ipcMain.handle('gallery:choose-dir', async () => {
  const options: OpenDialogOptions = {
    title: '选择图库保存目录',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || !result.filePaths[0]) return null

  const settings = await readSettings()
  const nextSettings = await saveSettings({
    ...settings,
    galleryDir: result.filePaths[0],
  })
  return nextSettings.galleryDir || result.filePaths[0]
})

ipcMain.handle(
  'models:list',
  async (_event, args: { baseUrl: string; apiKey: string }) => {
    const result = await fetchJson<{ data?: ModelOption[] }>(
      resolveUrl(args.baseUrl, '/v1/models'),
      {
        method: 'GET',
        headers: authHeaders(args.apiKey),
      },
      'Failed to fetch models'
    )

    const models = Array.isArray(result.data) ? result.data : []
    return models
      .filter((model) => model?.id)
      .sort((a, b) => a.id.localeCompare(b.id))
  }
)

ipcMain.handle(
  'images:generate',
  async (_event, payload: ImageGenerationPayload): Promise<ImageGenerationResult> => {
    const body = {
      model: payload.model,
      prompt: payload.prompt,
      size: payload.size,
      quality: payload.quality,
      n: payload.count,
      response_format: payload.responseFormat,
    }

    const result = await fetchJson<{
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
    }>(
      resolveUrl(payload.baseUrl, '/v1/images/generations'),
      {
        method: 'POST',
        headers: authHeaders(payload.apiKey),
        body: JSON.stringify(body),
      },
      'Image generation failed'
    )

    const data = Array.isArray(result.data) ? result.data : []
    const images: GeneratedImage[] = []

    for (const item of data) {
      if (item.b64_json) {
        images.push({
          src: `data:image/png;base64,${item.b64_json}`,
          revisedPrompt: item.revised_prompt,
        })
        continue
      }
      if (item.url) {
        images.push({
          src: await downloadAsDataUrl(item.url),
          revisedPrompt: item.revised_prompt,
        })
      }
    }

    if (images.length === 0) {
      throw new Error('No image returned by upstream')
    }

    return { images }
  }
)

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  createTray()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

declare global {
  namespace Electron {
    interface App {
      isQuiting?: boolean
    }
  }
}
