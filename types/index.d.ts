/** The marked turn's number, or null before one is known. */
export type Mark = number | null

declare module 'claude-code' {
  interface PluginState {
    timeline: {
      /** The turn whose card is marked. The pane reads it, so a change redraws the pane alone. */
      mark: Mark
    }
  }
}

