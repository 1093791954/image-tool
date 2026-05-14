import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ImageGenerationPayload,
  ImageGenerationResult,
  ModelOption,
} from './types.js'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  saveSettings: (settings: AppSettings) =>
    ipcRenderer.invoke('settings:save', settings) as Promise<AppSettings>,
  listModels: (args: { baseUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('models:list', args) as Promise<ModelOption[]>,
  generateImages: (payload: ImageGenerationPayload) =>
    ipcRenderer.invoke('images:generate', payload) as Promise<ImageGenerationResult>,
  openExternal: (url: string) =>
    ipcRenderer.invoke('external:open', url) as Promise<void>,
  listImages: () => ipcRenderer.invoke('images:list-local') as Promise<unknown>,
  saveImages: (records: unknown[]) =>
    ipcRenderer.invoke('images:save-local', records) as Promise<unknown>,
  deleteImage: (id: string) =>
    ipcRenderer.invoke('images:delete-local', id) as Promise<void>,
  clearImages: () => ipcRenderer.invoke('images:clear-local') as Promise<void>,
  chooseGalleryDir: () =>
    ipcRenderer.invoke('gallery:choose-dir') as Promise<string | null>,
}

contextBridge.exposeInMainWorld('imageTools', api)
