import { expect, mock, test } from 'claude-code/testing'
import type { Args, On, PromptOrigin } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BASH = { tool: 'Bash', command: 'true' } as const
const STEP = { model: 'm', messageCount: 1 } as const
const T0 = Date.parse('2026-10-19T20:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const RESUME_PROMPT = 'The quota window has reset. Continue where you left off.'

function pause($: Engine, args = '') {
  return $.command.run({
    command: 'pause',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

async function step($: Engine, e: Args<'turn.step'>) {
  for await (const _ of $.turn.step(e));
}

// A turn as the engine starts one: the prompt is submitted, then the turn starts.
async function turn($: Engine, turnId: string, origin: PromptOrigin) {
  await $.prompt.submit({ text: 'work', wait: false, origin })
  await $.turn.start({ text: 'work', turnId })
}

function complete($: Engine, turnId: string) {
  return $.turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 1, isAborted: false })
}

function measure($: Engine, percentUsed: number, resetsAt = T0 + 5 * HOUR) {
  return $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed, resetsAt: new Date(resetsAt).toISOString() },
      { kind: 'seven_day', percentUsed: 10 },
    ],
    changed: ['rateLimits'],
  })
}

function start($: Engine) {
  return $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

// The engine beneath the mod, with a clock that starts at T0 and moves only when a test moves it.
function engine(on: On) {
  const seen = {
    requests: 0,
    aborted: [] as string[],
    commands: [] as string[],
    prompts: [] as string[],
    status: undefined as string | undefined,
    clock: mock.clock(on, { now: T0 }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin') seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    seen.requests++
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.status', ($, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 96, resetsAt: '2026-10-20T01:00:00.000Z' },
        { kind: 'seven_day', percentUsed: 10 },
      ],
    },
  }))
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })

  return seen
}

test('/pause ends the running turn at its next step and sends no request', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect((await pause($)).text).toBe('Claude will stop before its next step.')
  await step($, { turnId: 't1', index: 1, ...STEP })
  await seen.clock.settle()
  expect(seen.requests).toBe(1)
  expect(seen.aborted).toEqual(['t1'])
  expect(seen.commands).toEqual([])
})

test('while paused, only a prompt from the person starts a turn that runs', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await pause($)
  await step($, { turnId: 't1', index: 0, ...STEP })
  await complete($, 't1')

  await turn($, 't2', { kind: 'task-notification' })
  await step($, { turnId: 't2', index: 0, ...STEP })
  await complete($, 't2')
  expect(seen.requests).toBe(0)
  expect(seen.aborted).toEqual(['t1', 't2'])

  await turn($, 't3', { kind: 'composer' })
  await step($, { turnId: 't3', index: 0, ...STEP })
  expect(seen.requests).toBe(1)
  expect((await $.tool.call(BASH)).deny).toBeUndefined()
})

test('a turn that ends on its own while a pause is requested stays paused', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await pause($)
  await complete($, 't1')

  await turn($, 't2', { kind: 'task-notification' })
  await step($, { turnId: 't2', index: 0, ...STEP })
  expect(seen.requests).toBe(0)
  expect(seen.aborted).toEqual(['t2'])
})

test('/pause while idle pauses at once', async ($, on) => {
  const seen = engine(on)

  expect((await pause($)).text).toBe('Paused until you send a prompt.')
  await turn($, 't1', { kind: 'task-notification' })
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(0)
})

test('the pause is held in session state, which a reload keeps', async ($, on) => {
  engine(on)
  const written: unknown[] = []
  on('state.set', { plugin: 'dymaxion', key: 'state' }, ($, e, next) => {
    written.push(e.value)
    return next(e)
  })

  await pause($)
  expect(written.at(-1)).toMatchObject({ isPaused: true })
})

test('parallel tool calls of one response abort the turn once', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await pause($)
  const results = await Promise.all([$.tool.call(BASH), $.tool.call(BASH)])
  expect(results.map(r => r.deny)).toEqual(['Paused.', 'Paused.'])
  expect(seen.aborted).toEqual(['t1'])
})

test('/pause compact stops the turn and compacts', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await pause($, 'compact')
  await step($, { turnId: 't1', index: 0, ...STEP })
  await seen.clock.settle()
  expect(seen.requests).toBe(0)
  expect(seen.commands).toEqual(['compact'])
})

test('/pause drops the next tool of a response', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await pause($)
  expect((await $.tool.call(BASH)).deny).toBe('Paused.')
  expect(seen.aborted).toEqual(['t1'])
})

const LIMIT_95 = { options: { quotaLimit: 95 } }

test('the quota pause is off unless set', async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await measure($, 99)
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(1)
})

test('a rate-limit window reaching the set limit stops the running turn', LIMIT_95, async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await measure($, 94.9)
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(1)

  await measure($, 95)
  await step($, { turnId: 't1', index: 1, ...STEP })
  expect(seen.requests).toBe(1)
  expect(seen.aborted).toEqual(['t1'])
})

test('once resumed, a window pauses again only after it resets', LIMIT_95, async ($, on) => {
  const seen = engine(on)

  await turn($, 't1', { kind: 'composer' })
  await measure($, 95)
  await step($, { turnId: 't1', index: 0, ...STEP })
  await complete($, 't1')

  await turn($, 't2', { kind: 'composer' })
  await measure($, 97)
  await step($, { turnId: 't2', index: 0, ...STEP })
  expect(seen.requests).toBe(1)

  await measure($, 3)
  await measure($, 95)
  await step($, { turnId: 't2', index: 1, ...STEP })
  expect(seen.requests).toBe(1)
  expect(seen.aborted).toEqual(['t1', 't2'])
})

test('/pause limit turns the quota pause on for the session', async ($, on) => {
  const seen = engine(on)

  expect((await pause($, 'limit 95')).text).toBe('This session pauses at 95% of a quota window.')
  await turn($, 't1', { kind: 'composer' })
  await measure($, 96)
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.aborted).toEqual(['t1'])
})

test('/pause limit off lets the session work past the limit', LIMIT_95, async ($, on) => {
  const seen = engine(on)

  expect((await pause($, 'limit')).text).toBe('This session pauses at 95% of a quota window.')
  expect((await pause($, 'limit off')).text).toBe('This session does not pause for quota.')
  await turn($, 't1', { kind: 'composer' })
  await measure($, 99)
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(1)
})

test('/pause status shows the pause, the quota limit and each window', LIMIT_95, async ($, on) => {
  engine(on)

  await turn($, 't1', { kind: 'composer' })
  await measure($, 96)
  expect((await pause($, 'status')).text).toBe(
    [
      'Pausing: Claude stops before its next step.',
      'Quota: this session pauses at 95% of a quota window (from the settings).',
      '5-hour limit: 96% used, resets 2026-10-20T01:00:00.000Z; paused for it once, again only after it resets',
      'weekly limit: 10% used',
    ].join('\n'),
  )
})

const RESUME_90 = { options: { quotaLimit: 90, quotaResume: true } }

test('with resume on, each quota pause resumes once its window resets', RESUME_90, async ($, on) => {
  const seen = engine(on)
  await start($)

  await turn($, 't1', { kind: 'composer' })
  await measure($, 90, T0 + HOUR)
  await step($, { turnId: 't1', index: 0, ...STEP })
  await complete($, 't1')
  expect(seen.aborted).toEqual(['t1'])

  await seen.clock.advance(HOUR)
  expect(seen.prompts).toEqual([])
  await seen.clock.advance(2 * MINUTE)
  expect(seen.prompts).toEqual([RESUME_PROMPT])

  // The turn the mod's own prompt starts runs, and the next time the window
  // reaches the limit the session pauses and resumes again.
  await $.turn.start({ text: RESUME_PROMPT, turnId: 't2' })
  await measure($, 2, T0 + 6 * HOUR)
  await step($, { turnId: 't2', index: 0, ...STEP })
  expect(seen.requests).toBe(1)
  await measure($, 90, T0 + 6 * HOUR)
  await step($, { turnId: 't2', index: 1, ...STEP })
  expect(seen.aborted).toEqual(['t1', 't2'])
  await seen.clock.set(T0 + 6 * HOUR + 2 * MINUTE)
  expect(seen.prompts).toEqual([RESUME_PROMPT, RESUME_PROMPT])
})

test('a window still at the limit after a resume pauses the session again', RESUME_90, async ($, on) => {
  const seen = engine(on)
  await start($)

  await measure($, 90, T0 + HOUR)
  await seen.clock.advance(HOUR + 2 * MINUTE)
  await $.turn.start({ text: RESUME_PROMPT, turnId: 't1' })
  await measure($, 91, T0 + 6 * HOUR)
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(0)
})

test('/pause limit 90 resume turns resuming on; a prompt from the person cancels the resume', async ($, on) => {
  const seen = engine(on)
  await start($)

  expect((await pause($, 'limit 90 resume')).text).toBe(
    'This session pauses at 90% of a quota window and resumes when it resets.',
  )
  await measure($, 90, T0 + HOUR)
  expect((await pause($, 'status')).text?.split('\n')[0]).toBe(
    'Paused until 2026-10-19T21:01:00.000Z, or until you send a prompt.',
  )
  await turn($, 't1', { kind: 'composer' })
  await seen.clock.advance(2 * HOUR)
  expect(seen.prompts).toEqual([])
})

test('a manual /pause holds through a quota pause that would resume', RESUME_90, async ($, on) => {
  const seen = engine(on)
  await start($)

  await pause($)
  await measure($, 90, T0 + HOUR)
  await seen.clock.advance(2 * HOUR)
  expect(seen.prompts).toEqual([])
})

test('the status line shows a quota limit that resumes, and when a pause resumes', RESUME_90, async ($, on) => {
  const seen = engine(on)
  await start($)

  expect(seen.status).toBe('pauses at 90%, resumes at reset')
  await measure($, 90, T0 + HOUR)
  expect(seen.status).toBe('paused until 2026-10-19T21:01:00.000Z')
  await seen.clock.advance(HOUR + 2 * MINUTE)
  expect(seen.status).toBe('pauses at 90%, resumes at reset')
})

test('the status line follows /pause limit', async ($, on) => {
  const seen = engine(on)
  await start($)

  expect(seen.status).toBeUndefined()
  await pause($, 'limit 90 resume')
  expect(seen.status).toBe('pauses at 90%, resumes at reset')
  await pause($, 'limit 90')
  expect(seen.status).toBeUndefined()
})

test('/pause until-reset waits for the most-used window to reset, then continues', async ($, on) => {
  const seen = engine(on)
  await start($)

  expect((await pause($, 'until-reset')).text).toBe('Paused until 2026-10-20T01:01:00.000Z, after the 5-hour window resets.')
  await turn($, 't1', { kind: 'task-notification' })
  await step($, { turnId: 't1', index: 0, ...STEP })
  expect(seen.requests).toBe(0)
  await seen.clock.set(T0 + 5 * HOUR)
  expect(seen.prompts).toEqual([])
  await seen.clock.set(T0 + 5 * HOUR + 2 * MINUTE)
  expect(seen.prompts).toEqual([RESUME_PROMPT])
})

test('/pause until-reset with a prompt sends that prompt at the reset', async ($, on) => {
  const seen = engine(on)
  await start($)

  await pause($, 'until-reset  yes, go with option 2')
  await seen.clock.set(T0 + 5 * HOUR + 2 * MINUTE)
  expect(seen.prompts).toEqual(['yes, go with option 2'])
})

test('/pause rejects unknown arguments', async ($, on) => {
  engine(on)

  await turn($, 't1', { kind: 'composer' })
  const invalid = ['now', 'resume', 'compact now', 'status now', 'limit high', 'limit 120', 'limit 95 now', 'limit off resume']
  for (const args of invalid) {
    expect((await pause($, args)).text).toBe('Usage: /pause [compact | status | until-reset [<prompt>]], or /pause limit [<percent> [resume] | off]')
  }
  expect((await $.tool.call(BASH)).deny).toBeUndefined()
})
