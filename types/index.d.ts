/** Bumped to redraw the pane alone. */
export type DrawCount = number

declare module 'claude-code' {
  interface PluginState {
    timeline: {
      /** The pane reads it, so bumping it redraws the pane and nothing else. */
      draw: DrawCount
    }
  }
}

