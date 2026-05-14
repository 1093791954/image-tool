/// <reference types="vite/client" />

import type { ImageToolsBridge } from './types'

declare global {
  interface Window {
    imageTools: ImageToolsBridge
  }
}
