import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'
import type { Pause, Quota } from '../types'

const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping'])
const USAGE = 'Usage: /pause [compact | status | until-reset [<prompt>]], or /pause limit [<percent> [resume] | off]'
const WINDOW_NAMES: Readonly<Record<string, string>> = { five_hour: '5-hour', seven_day: 'weekly' }
const RESUME_PROMPT = 'The quota window has reset. Continue where you left off.'
// The reset time is the server's; the margin keeps the resumed turn past it.
const RESUME_MARGIN_MS = 60_000
const RESUME_POLL_MS = 60_000

// Held by the host, so the pause outlives a reload of this module.
const pause = atom({ plugin: 'dymaxion', key: 'state' } as const, {
  isPaused: false,
  runningTurnId: null,
  abortedTurnId: null,
  nextTurnOrigin: null,
  windowsAtLimit: [],
  sessionQuota: null,
  resume: null,
})

// A value an earlier version of the mod wrote lacks the fields added since.
function current(s: Pause): Pause {
  return { ...pause.initial, ...s }
}

async function load($: EngineInterface) {
  return current(await read($, pause))
}

// Holds until the person's prompt; a pause that resumes on its own sets resume after it.
function paused(s: Pause): Pause {
  return { ...s, isPaused: true, nextTurnOrigin: null, resume: null }
}

// windowsAtLimit is emptied so a window still at the limit pauses the session again.
function resumed(s: Pause): Pause {
  return { ...s, isPaused: false, resume: null, windowsAtLimit: [] }
}

function atLimit(windows: readonly SessionRateLimit[], quota: Quota) {
  return quota.percent > 0 ? windows.filter(w => w.percentUsed >= quota.percent) : []
}

// When every one of `windows` has reset; null when one does not say.
function resetOf(windows: readonly SessionRateLimit[]) {
  const times = windows.map(w => (w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)))
  return times.some(Number.isNaN) ? null : Math.max(...times)
}

function quotaText(q: Quota) {
  if (q.percent <= 0) return 'does not pause for quota'
  return `pauses at ${q.percent}% of a quota window${q.isResuming ? ' and resumes when it resets' : ''}`
}

function isRunning(s: Pause) {
  return s.runningTurnId !== null && s.runningTurnId !== s.abortedTurnId
}

function statusOf(s: Pause, setting: Quota) {
  if (s.isPaused) {
    if (isRunning(s)) return 'pausing'
    return s.resume === null ? 'paused' : `paused until ${new Date(s.resume.at).toISOString()}`
  }
  const quota = s.sessionQuota ?? setting
  return quota.percent > 0 && quota.isResuming ? `pauses at ${quota.percent}%, resumes at reset` : undefined
}

// Also answers the state the write replaced, so of two callers racing to make
// the same change, each can tell whether it was the one that made it.
async function write($: EngineInterface, setting: Quota, change: (s: Pause) => Pause) {
  let before = pause.initial
  const after = await update($, pause, s => change((before = current(s))))
  const status = statusOf(after, setting)
  if (status !== statusOf(before, setting)) $.ui.status(status)

  return { before, after }
}

// Parallel tool calls of one response each stop the turn; only the first aborts it.
async function stop($: EngineInterface, setting: Quota, turnId: string) {
  const { before } = await write($, setting, s => ({ ...s, abortedTurnId: turnId }))
  if (before.abortedTurnId !== turnId) await $.turn.abort({ turnId })
}

async function resumeIfDue($: EngineInterface, setting: Quota) {
  const now = await $.clock.now()
  const s = await load($)
  if (s.resume === null || now < s.resume.at) return
  const { before } = await write($, setting, t => (t.resume === null ? t : resumed(t)))
  if (before.resume !== null) await $.prompt.submit({ text: before.resume.prompt })
}

// Waits for the most-used window, the one holding the session back; of several
// used as much, for the last to reset.
async function runUntilReset($: EngineInterface, setting: Quota, prompt: string) {
  const { rateLimits } = await $.session.usage()
  const most = Math.max(...rateLimits.map(w => w.percentUsed))
  const windows = rateLimits.filter(w => w.percentUsed === most)
  const reset = windows.length === 0 ? null : resetOf(windows)
  if (reset === null || reset <= (await $.clock.now())) {
    return { text: 'No quota reading gives a reset still to come, so there is nothing to wait for.' }
  }
  const at = reset + RESUME_MARGIN_MS
  await write($, setting, s => ({ ...paused(s), resume: { at, prompt: prompt === '' ? RESUME_PROMPT : prompt } }))
  const names = windows.map(w => WINDOW_NAMES[w.kind] ?? w.kind).join(' and ')

  return { text: `Paused until ${new Date(at).toISOString()}, after the ${names} window resets.` }
}

async function runLimit($: EngineInterface, args: readonly string[], setting: Quota) {
  const [value, mode, ...rest] = args
  if (value === undefined) return { text: `This session ${quotaText((await load($)).sessionQuota ?? setting)}.` }
  const percent = value === 'off' ? 0 : Number(value)
  const isResuming = mode === 'resume'
  const isValid = percent >= 0 && percent <= 100 && rest.length === 0 && (mode === undefined || (isResuming && percent > 0))
  if (!isValid) return { text: USAGE }
  const quota = { percent, isResuming }
  await write($, setting, s => ({ ...s, sessionQuota: quota, resume: isResuming ? s.resume : null }))

  return { text: `This session ${quotaText(quota)}.` }
}

async function runStatus($: EngineInterface, setting: Quota) {
  const s = await load($)
  const { rateLimits } = await $.session.usage()
  const pauseLine = !s.isPaused
    ? 'Not paused.'
    : isRunning(s)
      ? 'Pausing: Claude stops before its next step.'
      : s.resume === null
        ? 'Paused until you send a prompt.'
        : `Paused until ${new Date(s.resume.at).toISOString()}, or until you send a prompt.`
  const source = s.sessionQuota === null ? 'from the settings' : 'set by /pause limit'
  const windowLines = rateLimits.map(w => {
    const resets = w.resetsAt === undefined ? '' : `, resets ${w.resetsAt}`
    const held = s.windowsAtLimit.includes(w.kind) ? '; paused for it once, again only after it resets' : ''
    return `${WINDOW_NAMES[w.kind] ?? w.kind} limit: ${w.percentUsed}% used${resets}${held}`
  })

  return {
    text: [pauseLine, `Quota: this session ${quotaText(s.sessionQuota ?? setting)} (${source}).`, ...windowLines].join(
      '\n',
    ),
  }
}

export const register: Register = (on, options) => {
  const setting: Quota = {
    percent: typeof options.quotaLimit === 'number' ? options.quotaLimit : 0,
    isResuming: options.quotaResume === true,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pause',
      description: 'Stop once the running tool finishes and stay paused until you send a prompt',
      argumentHint: '[compact | status | until-reset [prompt] | limit <percent> [resume] | limit off]',
      immediate: true,
    })
    // After a reload, show the pause the host still holds.
    $.ui.status(statusOf(await load($), setting))
    // Polled rather than one long wait, so a machine that slept past a reset
    // still resumes soon after it wakes.
    $.clock.every(RESUME_POLL_MS, () => void resumeIfDue($, setting))

    return next(e)
  })

  on('command.run', { command: 'pause' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'limit') return runLimit($, rest, setting)
    if (verb === 'status' && rest.length === 0) return runStatus($, setting)
    if (verb === 'until-reset') return runUntilReset($, setting, e.args.trim().slice(verb.length).trim())
    if (rest.length > 0 || (verb !== '' && verb !== 'compact')) return { text: USAGE }
    const isCompacting = verb === 'compact'

    const { after } = await write($, setting, paused)
    // Queued until the session is idle: it runs once the turn stops, while the prompt cache is warm.
    if (isCompacting) $.clock.after(0, () => void $.command.run({ command: 'compact' }))
    if (!isRunning(after)) {
      return { text: isCompacting ? 'Paused; compacting now.' : 'Paused until you send a prompt.' }
    }

    return {
      text: isCompacting
        ? 'Claude will stop before its next step, then compact.'
        : 'Claude will stop before its next step.',
    }
  })

  // A window pauses the session when it reaches the limit, which is off unless
  // set. Once the session resumes, the same window pauses it again only after
  // it has reset. A pause holding for the person's prompt keeps holding; one
  // that resumes on its own waits for this window too.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const { before, after } = await write($, setting, s => {
      const quota = s.sessionQuota ?? setting
      const windows = atLimit(e.rateLimits, quota)
      const t = { ...s, windowsAtLimit: windows.map(w => w.kind) }
      if (!windows.some(w => !s.windowsAtLimit.includes(w.kind))) return t
      const reset = resetOf(windows)
      const at = reset !== null && reset > now ? reset + RESUME_MARGIN_MS : null
      if (s.isPaused) {
        return s.resume === null || at === null ? t : { ...t, resume: { ...s.resume, at: Math.max(s.resume.at, at) } }
      }

      return { ...paused(t), resume: quota.isResuming && at !== null ? { at, prompt: RESUME_PROMPT } : null }
    })
    const reached = atLimit(e.rateLimits, before.sessionQuota ?? setting).find(
      w => !before.windowsAtLimit.includes(w.kind),
    )
    if (reached !== undefined) {
      const name = WINDOW_NAMES[reached.kind] ?? reached.kind
      const then =
        after.resume === null ? 'Send a prompt to go on.' : `Resuming at ${new Date(after.resume.at).toISOString()}.`
      $.ui.toast(`Pausing: the ${name} limit is at ${reached.percentUsed}%. ${then}`)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) await write($, setting, s => ({ ...s, nextTurnOrigin: e.origin.kind }))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId !== undefined) return started

    await write($, setting, s => {
      const t = { ...s, runningTurnId: started.turnId, nextTurnOrigin: null }
      return s.isPaused && PERSON_ORIGINS.has(s.nextTurnOrigin ?? '') ? { ...t, isPaused: false, resume: null } : t
    })

    return started
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await write($, setting, s => (s.runningTurnId === e.turnId ? { ...s, runningTurnId: null } : s))
    }

    return next(e)
  })

  // The two boundaries of the main loop: the next model request, and the next
  // tool of a response whose earlier tools ran one after another.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await load($)).isPaused) return yield* next(e)
    await stop($, setting, e.turnId)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const s = await load($)
    if (!s.isPaused || s.runningTurnId === null) return next(e)
    await stop($, setting, s.runningTurnId)

    return { deny: 'Paused.' }
  })
}
