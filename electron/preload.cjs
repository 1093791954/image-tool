const { contextBridge, ipcRenderer } = require('electron')

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  listModels: (args) => ipcRenderer.invoke('models:list', args),
  generateImages: (payload) => ipcRenderer.invoke('images:generate', payload),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  listImages: () => ipcRenderer.invoke('images:list-local'),
  saveImages: (records) => ipcRenderer.invoke('images:save-local', records),
  deleteImage: (id) => ipcRenderer.invoke('images:delete-local', id),
  clearImages: () => ipcRenderer.invoke('images:clear-local'),
  chooseGalleryDir: () => ipcRenderer.invoke('gallery:choose-dir'),
}

contextBridge.exposeInMainWorld('imageTools', api)
