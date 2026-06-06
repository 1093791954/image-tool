import type {
  AppSettings,
  BackupFile,
  BackupSettings,
  LocalImageRecord,
} from './types'

const DB_NAME = 'gpt-image-tools'
const DB_VERSION = 3
const IMAGES_STORE = 'images'
const REFERENCE_IMAGE_BLOBS_STORE = 'reference-image-blobs'
const SETTINGS_STORE = 'settings'
const SETTINGS_ID = 'app'

const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://hotapi.top',
  textBaseUrl: 'https://hotapi.top',
  imageBaseUrl: 'https://hotapi.top',
  persistApiKey: false,
  apiKey: '',
  codexApiKey: '',
  imageRetryCount: 0,
  textModel: 'gpt-5.5',
  themeMode: 'dark',
}

function normalizeRetryCount(value: unknown) {
  const count = Math.floor(Number(value))
  if (!Number.isFinite(count)) return DEFAULT_SETTINGS.imageRetryCount ?? 0
  return Math.max(0, Math.min(5, count))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        const store = db.createObjectStore(IMAGES_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains(REFERENCE_IMAGE_BLOBS_STORE)) {
        db.createObjectStore(REFERENCE_IMAGE_BLOBS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    const request = callback(store)
    let result: T | undefined

    if (request) {
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(request.error)
    }

    tx.oncomplete = () => {
      db.close()
      resolve(result)
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error)
    }
  })
}

function normalizeSettings(settings: Partial<AppSettings> | undefined): AppSettings {
  const legacyBaseUrl = settings?.baseUrl || DEFAULT_SETTINGS.baseUrl

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    baseUrl: legacyBaseUrl,
    textBaseUrl: settings?.textBaseUrl || legacyBaseUrl,
    imageBaseUrl: settings?.imageBaseUrl || legacyBaseUrl,
    persistApiKey: Boolean(settings?.persistApiKey),
    apiKey: settings?.persistApiKey ? settings.apiKey || '' : '',
    codexApiKey: settings?.persistApiKey ? settings.codexApiKey || '' : '',
    imageRetryCount: normalizeRetryCount(settings?.imageRetryCount),
    textModel: settings?.textModel || DEFAULT_SETTINGS.textModel,
    themeMode: settings?.themeMode || 'dark',
  }
}

function backupSettingsFrom(settings: AppSettings): BackupSettings {
  return {
    baseUrl: settings.baseUrl || DEFAULT_SETTINGS.baseUrl,
    textBaseUrl: settings.textBaseUrl || settings.baseUrl || DEFAULT_SETTINGS.textBaseUrl,
    imageBaseUrl: settings.imageBaseUrl || settings.baseUrl || DEFAULT_SETTINGS.imageBaseUrl,
    persistApiKey: false,
    imageRetryCount: settings.imageRetryCount ?? DEFAULT_SETTINGS.imageRetryCount,
    textModel: settings.textModel || DEFAULT_SETTINGS.textModel,
    themeMode: settings.themeMode || 'system',
  }
}

function isImageRecord(value: unknown): value is LocalImageRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<LocalImageRecord>
  return (
    typeof record.id === 'string' &&
    typeof record.src === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.model === 'string' &&
    typeof record.size === 'string' &&
    typeof record.quality === 'string' &&
    typeof record.createdAt === 'number'
  )
}

export async function getSettings(): Promise<AppSettings> {
  const result = await withStore<{ id: string; value: AppSettings }>(
    SETTINGS_STORE,
    'readonly',
    (store) => store.get(SETTINGS_ID)
  )
  return normalizeSettings(result?.value)
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const nextSettings = normalizeSettings(settings)
  await withStore(SETTINGS_STORE, 'readwrite', (store) => {
    store.put({ id: SETTINGS_ID, value: nextSettings })
  })
  return nextSettings
}

export async function listImages(): Promise<LocalImageRecord[]> {
  const result = await withStore<LocalImageRecord[]>(
    IMAGES_STORE,
    'readonly',
    (store) => store.getAll()
  )
  return (result || []).sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveImages(records: LocalImageRecord[]) {
  await withStore(IMAGES_STORE, 'readwrite', (store) => {
    records.forEach((record) => store.put(record))
  })
}

export async function deleteImage(id: string) {
  await withStore(IMAGES_STORE, 'readwrite', (store) => {
    store.delete(id)
  })
}

export async function clearImages() {
  await withStore(IMAGES_STORE, 'readwrite', (store) => {
    store.clear()
  })
}

export type ReferenceImageBlobRecord = {
  id: string
  dataUrl: string
}

export async function listReferenceImageBlobs(): Promise<ReferenceImageBlobRecord[]> {
  const result = await withStore<ReferenceImageBlobRecord[]>(
    REFERENCE_IMAGE_BLOBS_STORE,
    'readonly',
    (store) => store.getAll()
  )
  return result || []
}

export async function saveReferenceImageBlobs(records: ReferenceImageBlobRecord[]) {
  await withStore(REFERENCE_IMAGE_BLOBS_STORE, 'readwrite', (store) => {
    store.clear()
    records.forEach((record) => store.put(record))
  })
}

export async function exportBackup(): Promise<BackupFile> {
  const [settings, images] = await Promise.all([getSettings(), listImages()])
  return {
    version: 1,
    exportedAt: Date.now(),
    settings: backupSettingsFrom(settings),
    images,
  }
}

export async function importBackup(backup: unknown): Promise<number> {
  if (!backup || typeof backup !== 'object') {
    throw new Error('备份文件格式不正确')
  }

  const candidate = backup as Partial<BackupFile>
  if (candidate.version !== 1 || !Array.isArray(candidate.images)) {
    throw new Error('不支持的备份文件版本')
  }

  const images = candidate.images.filter(isImageRecord)
  await saveImages(images)

  if (candidate.settings) {
    const current = await getSettings()
    await saveSettings({
      ...current,
      baseUrl: candidate.settings.baseUrl || current.baseUrl,
      textBaseUrl:
        candidate.settings.textBaseUrl || candidate.settings.baseUrl || current.textBaseUrl,
      imageBaseUrl:
        candidate.settings.imageBaseUrl || candidate.settings.baseUrl || current.imageBaseUrl,
      imageRetryCount: normalizeRetryCount(
        candidate.settings.imageRetryCount ?? current.imageRetryCount
      ),
      textModel: candidate.settings.textModel || current.textModel,
      themeMode: candidate.settings.themeMode || current.themeMode,
      persistApiKey: false,
      apiKey: '',
      codexApiKey: '',
    })
  }

  return images.length
}
