/** When the session pauses for quota: at `percent` of a window (0: never), whether it compacts, and whether it resumes at the reset. */
export type Quota = { percent: number; isResuming: boolean; isCompacting: boolean }

export type Pause = {
  isPaused: boolean
  /** The main turn that started and has not completed. */
  runningTurnId: string | null
  /** The main turn the mod aborted; its turn.complete may come later or not at all. */
  abortedTurnId: string | null
  /** The origin of the prompt the next main turn starts from. */
  nextTurnOrigin: string | null
  /** The rate-limit windows at or past the limit at the last measurement. */
  windowsAtLimit: string[]
  /** The quota /pause limit set for this session; null follows the settings. */
  sessionQuota: Quota | null
  /** When a pause resumes on its own (epoch milliseconds) and the prompt it sends; null holds until the person's prompt. */
  resume: { at: number; prompt: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    dymaxion: { state: Pause }
  }
}
