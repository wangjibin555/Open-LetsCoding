import type { LetsCodingApi } from '../../preload/index'

declare global {
  interface Window {
    letscoding: LetsCodingApi
  }
}

export {}
