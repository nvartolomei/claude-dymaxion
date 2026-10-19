/** When the session pauses for quota: at `percent` of a window (0: never), resuming at its reset or not. */
export type Quota = { percent: number; isResuming: boolean }

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
  /** When a quota pause resumes on its own, in epoch milliseconds; null holds until a prompt. */
  resumeAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    dymaxion: { state: Pause }
  }
}
