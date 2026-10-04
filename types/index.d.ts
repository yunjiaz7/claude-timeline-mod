declare module 'claude-code' {
  interface PluginState {
    timeline: { marked: number | null }
  }
}

export type Marked = number | null
