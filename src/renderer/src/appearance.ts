// 外观偏好：背景预设（CSS 变量覆盖）+ 界面缩放（webFrame zoom）+ 会话卡片字号。
// 持久化走 settings.appearance（state.db，D5 落点），应用入口唯一（App 启动 + 设置页变更）。

export interface Appearance {
  bg: string
  zoom: number
  cardFs: number
}

export const DEFAULT_APPEARANCE: Appearance = { bg: 'default', zoom: 1, cardFs: 13 }

/** 背景预设：只覆盖底色系变量，文字/信号色不动（D0 浅色+琥珀基调保持） */
export const BG_PRESETS: Record<string, { label: string; swatch: string; vars: Record<string, string> }> = {
  default: { label: '默认', swatch: '#f3f4f7', vars: {} },
  warm: {
    label: '暖白',
    swatch: '#f6f3ec',
    vars: {
      '--page': '#f6f3ec',
      '--side': '#f1ece1',
      '--panel': '#faf7f0',
      '--win': '#fffdf8',
      '--raise': '#ebe5d8',
      '--block-bg': '#fbf8f2',
      '--code-bg': '#f3efe6'
    }
  },
  cool: {
    label: '冷灰',
    swatch: '#edf0f5',
    vars: {
      '--page': '#edf0f5',
      '--side': '#e7ebf2',
      '--panel': '#f2f5f9',
      '--win': '#fcfdff',
      '--raise': '#e2e7ef',
      '--block-bg': '#f7f9fc',
      '--code-bg': '#eef2f7'
    }
  },
  sage: {
    label: '黛青',
    swatch: '#eef2f0',
    vars: {
      '--page': '#eef2f0',
      '--side': '#e8ede9',
      '--panel': '#f3f6f4',
      '--win': '#fcfefd',
      '--raise': '#e2e8e4',
      '--block-bg': '#f7faf8',
      '--code-bg': '#eff3f0'
    }
  }
}

export const ZOOM_OPTIONS = [0.9, 1, 1.1, 1.2]
export const CARD_FS_OPTIONS = [12, 13, 14]

export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return DEFAULT_APPEARANCE
  try {
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement
  // 先清空所有预设的覆盖，再应用当前，避免切预设残留
  for (const p of Object.values(BG_PRESETS)) {
    for (const k of Object.keys(p.vars)) root.style.removeProperty(k)
  }
  const preset = BG_PRESETS[a.bg]
  if (preset) {
    for (const [k, v] of Object.entries(preset.vars)) root.style.setProperty(k, v)
  }
  root.style.setProperty('--sess-fs', `${a.cardFs}px`)
  window.letscoding.ui.setZoom(a.zoom)
}
