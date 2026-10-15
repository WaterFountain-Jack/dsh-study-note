import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from '../src/recorder.js'
import { resolveConfig } from '../src/config.js'

export const decision = (patch = {}) => ({
  action: 'create', title: 'callback 与函数调用', documentTitle: 'Cordis 学习', topic: 'inbox',
  summary: '学习 callback、effect 和插件运行机制。', question: 'callback 是什么？',
  conclusion: 'callback 是交给其他代码调用的函数。', explanation: '传入函数与立即调用函数不同。',
  example: '```js\nctx.effect(callback)\n```', openQuestions: ['何时执行清理函数？'],
  understandingDraft: '我把函数交给框架，由框架选择调用时机。', ...patch,
})

export function model(handler = () => decision()) {
  return {
    calls: [],
    async * stream(request) {
      this.calls.push(request)
      const value = await handler(request, this.calls.length)
      yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

export async function fixture(t, llm = model(), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-study-note-test-'))
  const config = resolveConfig({ notesDir: join(directory, 'notes'), debounceMs: 60000, ...overrides })
  const recorder = new Recorder(config, llm, { info() {}, warn() {} })
  await recorder.open()
  t.after(async () => { await recorder.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, root: config.notesDir, config, recorder, llm }
}

export const session = id => ({
  id, header: { id, createdAt: 0 }, events: [],
  append(type, data, options = {}) { return Object.assign(append(this, type, data, options.surfaceOp), options) },
})

export function append(session, type, data, surfaceOp) {
  const event = { seq: session.events.length, type, time: Date.now(), data, ...(surfaceOp ? { surfaceOp } : {}) }
  session.events.push(event)
  return event
}

export function turn(session, question = 'callback 是什么？', answer = 'callback 是回调函数。', options = {}) {
  const number = session.events.filter(event => event.type === 'turn/start').length + 1
  append(session, 'turn/start', { turn: number })
  append(session, 'user/message', { source: { kind: options.source ?? 'user' }, content: [{ type: 'text', text: question }] }, 'append')
  append(session, 'assistant/message', {
    turn: number, step: 1, ...(options.interrupted ? { interrupted: true } : {}),
    message: { source: { kind: 'model', provider: 'test', model: 'test-model' }, content: [{ type: 'text', text: answer }, { type: 'reasoning', text: 'PRIVATE REASONING' }] },
  }, 'append')
  return append(session, 'turn/end', { turn: number, reason: { kind: options.reason ?? 'completed' } })
}

export const command = (recorder, session, rawInput) => recorder.command({ agent: { session }, rawInput, signal: new AbortController().signal })

export async function sync(recorder, session) {
  const result = await command(recorder, session, 'sync')
  if (result.kind === 'error') throw new Error(result.text)
  return result
}
