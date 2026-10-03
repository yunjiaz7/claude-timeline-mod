export type Segment = {
  at: string
  prompt: string
  origin: string
  files: string[]
  cmds: string[]
  tools: Record<string, number>
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    timeline: { segments: Segment[] }
  }
}
