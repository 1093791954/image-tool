import type {
  AppSettings,
  BackupFile,
  BackupSettings,
  LocalImageRecord,
} from './types'

const DB_NAME = 'gpt-image-tools'
const DB_VERSION = 2
const IMAGES_STORE = 'images'
const SETTINGS_STORE = 'settings'
const SETTINGS_ID = 'app'

const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://cc.api-corp.top',
  persistApiKey: false,
  apiKey: '',
  themeMode: 'system',
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
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    persistApiKey: Boolean(settings?.persistApiKey),
    apiKey: settings?.persistApiKey ? settings.apiKey || '' : '',
    themeMode: settings?.themeMode || 'system',
  }
}

function backupSettingsFrom(settings: AppSettings): BackupSettings {
  return {
    baseUrl: settings.baseUrl || DEFAULT_SETTINGS.baseUrl,
    persistApiKey: false,
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
      themeMode: candidate.settings.themeMode || current.themeMode,
      persistApiKey: false,
      apiKey: '',
    })
  }

  return images.length
}
