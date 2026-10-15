import { randomUUID } from 'node:crypto'
import { NoteStore, digest, validTopic } from './store.js'
import { collectTurns } from './transcript.js'
import { generate, prepareRequest } from './model.js'

const HELP = '/note on [分类] | off | status | sync | topic <分类> | reindex | new'

/** Per-session opt-in, background coalescing, cancellation, and durable checkpoints. */
export class Recorder {
  constructor(config, llm, logger = console) {
    this.config = config
    this.llm = llm
    this.logger = logger
    this.store = new NoteStore(config.notesDir)
    this.flags = new Map()
    this.jobs = new Map()
    this.closed = false
    this.commands = new Set()
    this.controls = new Map()
  }

  async open() { await this.store.open() }

  flag(id) {
    if (!this.flags.has(id)) {
      const state = this.store.get(id)
      this.flags.set(id, { enabled: state?.enabled ?? false, epoch: state?.epoch ?? 0 })
    }
    return this.flags.get(id)
  }

  eligible(id, epoch) { const flag = this.flag(id); return !this.closed && flag.enabled && flag.epoch === epoch }

  observe(session, event) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') this.schedule(session, event.seq)
  }

  resume(session) {
    const end = session.events.findLast(event => event.type === 'turn/end')
    if (end) this.schedule(session, end.seq)
  }

  schedule(session, endSeq) {
    if (this.closed || !this.flag(session.id).enabled) return
    let job = this.jobs.get(session.id)
    if (!job) { job = { session, endSeq, timer: undefined, running: undefined, controller: undefined }; this.jobs.set(session.id, job) }
    job.endSeq = Math.max(job.endSeq, endSeq)
    if (job.timer) clearTimeout(job.timer)
    if (job.running) return
    job.timer = setTimeout(() => {
      job.timer = undefined
      void this.start(job).catch(error => this.logger.warn(`study-note: ${error.message}`))
    }, this.config.debounceMs)
    job.timer.unref?.()
  }

  async start(job) {
    if (job.running) return job.running
    if (!this.flag(job.session.id).enabled || this.closed) return
    if (job.timer) { clearTimeout(job.timer); job.timer = undefined }
    const epoch = this.flag(job.session.id).epoch
    const endSeq = job.endSeq
    const controller = new AbortController()
    job.controller = controller
    job.running = this.process(job.session, endSeq, epoch, controller.signal)
    try { await job.running } finally {
      job.running = undefined
      job.controller = undefined
      if (job.endSeq > endSeq && this.eligible(job.session.id, epoch)) this.schedule(job.session, job.endSeq)
    }
  }

  async process(session, endSeq, epoch, signal) {
    const id = session.id
    try {
      let document = await this.store.findDocument(id)
      const state = this.store.get(id)
      const fromSeq = Math.max(state.lastSeq, document?.meta.lastEndSeq ?? -1)
      if (fromSeq >= endSeq) {
        if (document) await this.store.serial(async () => {
          if (!this.eligible(id, epoch) || signal.aborted) return
          await this.store.reindex()
          await this.store.update(id, { lastSeq: fromSeq, lastError: null })
        })
        return
      }
      for (const turn of collectTurns(session, fromSeq, endSeq)) {
        if (!this.eligible(id, epoch) || signal.aborted) return
        const topics = await this.store.topics()
        const request = prepareRequest(this.config, turn, document?.sections ?? [], topics, id, this.store.get(id).topic)
        const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
        let dispatched = false
        await this.store.serial(async () => {
          if (!this.eligible(id, epoch) || activeSignal.aborted) return
          await this.store.write(`.study-note/requests/${digest(id).slice(0, 16)}-${randomUUID()}.json`,
            JSON.stringify({ recordedAt: new Date().toISOString(), sourceSeqs: turn.sourceSeqs, request }, null, 2) + '\n')
          dispatched = true
        })
        if (!dispatched || !this.eligible(id, epoch)) return
        const value = await generate(this.llm, request, activeSignal, this.config.maxOutputBytes)
        await this.store.serial(async () => {
          if (!this.eligible(id, epoch) || activeSignal.aborted) return
          if (value.action === 'skip') {
            await this.store.update(id, { lastSeq: turn.endSeq, lastError: null })
          } else {
            const path = await this.store.saveDecision(id, turn, value, document, topics)
            this.logger.info(`study-note: 已更新 ${path}`)
            document = await this.store.findDocument(id)
          }
        })
      }
      await this.store.serial(async () => {
        if (!this.eligible(id, epoch) || signal.aborted) return
        if (document) await this.store.reindex()
        await this.store.update(id, { lastSeq: endSeq, lastError: null })
      })
    } catch (error) {
      if (signal.aborted || !this.eligible(id, epoch)) return
      await this.store.serial(async () => {
        if (this.eligible(id, epoch)) await this.store.update(id, { lastError: error.message })
      })
      throw error
    }
  }

  /** Cancel generation and join any commit already started before acknowledging off. */
  async cancel(id) {
    const flag = this.flag(id)
    flag.enabled = false
    flag.epoch++
    const job = this.jobs.get(id)
    if (job?.timer) { clearTimeout(job.timer); job.timer = undefined }
    job?.controller?.abort(new Error('study-note: 当前会话已停止记录。'))
    if (job?.running) await job.running.catch(() => {})
    this.jobs.delete(id)
    return flag
  }

  /** Commands are user-only controls; they are never exposed as model tools. */
  async command(invocation) {
    const id = invocation.agent.session.id
    const action = invocation.rawInput.trim().split(/\s+/u)[0]
    const controlled = ['on', 'off', 'topic', 'new'].includes(action)
    const operation = controlled
      ? (this.controls.get(id) ?? Promise.resolve()).then(() => this.execute(invocation))
      : this.execute(invocation)
    if (controlled) this.controls.set(id, operation.catch(() => {}))
    this.commands.add(operation)
    try { return await operation } catch (error) {
      return { kind: 'error', text: error.message }
    } finally { this.commands.delete(operation) }
  }

  async execute({ agent, rawInput, signal }) {
    signal.throwIfAborted()
    if (this.closed) throw new Error('study-note: 插件正在卸载。')
    const session = agent.session
    const id = session.id
    if (session.header.origin === 'subagent') throw new Error('study-note: 请在主对话中开启笔记，不采集子 Agent 内部对话。')
    const [action = 'status', ...args] = rawInput.trim().split(/\s+/u).filter(Boolean)
    const flag = this.flag(id)
    if (action === 'on') {
      if (args.length > 1 || (args[0] && !validTopic(args[0]))) throw new Error(HELP)
      if (flag.enabled) return { kind: 'success', text: '当前对话已经开启记录。用 /note topic <分类> 修改分类。' }
      const document = await this.store.findDocument(id)
      const boundary = session.events.length - 1
      const nextEpoch = flag.epoch + 1
      await this.store.serial(async () => {
        signal.throwIfAborted()
        if (args[0]) await this.store.move(id, args[0])
        await this.store.update(id, { enabled: true, epoch: nextEpoch, lastSeq: boundary, lastError: null })
      })
      Object.assign(flag, { enabled: true, epoch: nextEpoch })
      return { kind: 'success', text: `已开启当前对话的笔记记录，仅处理此后开始的完整问答。会额外调用整理模型并在本地保存整理请求。目录：${this.config.notesDir}${document ? '；继续更新原笔记。' : ''}` }
    }
    if (args.length && action !== 'topic') throw new Error(HELP)
    if (action === 'off') {
      if (!flag.enabled && !this.store.get(id)) return { kind: 'success', text: '当前对话默认关闭，没有生成笔记。' }
      await this.cancel(id)
      await this.store.serial(() => this.store.update(id, { enabled: false, epoch: flag.epoch }))
      return { kind: 'success', text: '当前对话已关闭记录；后台任务已停止，已有笔记保留。' }
    }
    if (action === 'status') {
      const state = this.store.get(id)
      const document = state?.notePath ? await this.store.findDocument(id).catch(error => ({ error: error.message })) : undefined
      return { kind: 'success', text: [
        `当前对话笔记：${flag.enabled ? '开启' : '关闭'}`,
        `目录：${this.config.notesDir}`,
        `分类：${state?.topic ?? '自动选择已有分类，不确定归 inbox'}`,
        `笔记：${document?.path ?? '尚未生成'}`,
        `后台任务：${this.jobs.get(id)?.running ? '整理中' : this.jobs.get(id)?.timer ? '等待整理' : '空闲'}`,
        `最近问题：${document?.error ?? state?.lastError ?? '无'}`,
      ].join('\n') }
    }
    if (action === 'sync') {
      if (!flag.enabled) throw new Error('请先 /note on；关闭时不会调用整理模型。')
      const end = session.events.findLast(event => event.type === 'turn/end')
      if (!end) return { kind: 'success', text: '尚无完整问答。' }
      this.schedule(session, end.seq)
      const job = this.jobs.get(id)
      if (!job) throw new Error('study-note: 当前对话已停止记录。')
      if (job.running) await job.running
      await this.start(job)
      return { kind: 'success', text: '当前已完成问答已检查。用 /note status 查看保存位置。' }
    }
    if (action === 'reindex') {
      const count = await this.store.serial(() => this.store.reindex())
      return { kind: 'success', text: `已重建插件索引，共 ${count} 份笔记；手写索引未改动。` }
    }
    if (action === 'topic') {
      if (args.length !== 1 || !validTopic(args[0])) throw new Error(HELP)
      if (!this.store.get(id)) throw new Error('请先 /note on 开启本对话。')
      const enabled = flag.enabled
      await this.cancel(id)
      try {
        await this.store.serial(async () => {
          await this.store.move(id, args[0])
          await this.store.update(id, { enabled, epoch: flag.epoch })
        })
      } finally {
        if (!this.closed) {
          flag.enabled = enabled
          if (enabled) this.resume(session)
        }
      }
      return { kind: 'success', text: `当前对话分类已设为 ${args[0]}，已有笔记与索引已更新。` }
    }
    if (action === 'new') {
      if ((await this.store.documents()).some(document => document.meta.sessionId === id)) throw new Error('原笔记仍存在，请继续更新原笔记。/note new 仅用于删除笔记后的重新建档。')
      await this.cancel(id)
      await this.store.serial(() => this.store.update(id, { enabled: false, epoch: flag.epoch, lastSeq: session.events.length - 1, notePath: undefined, lastError: null }))
      return { kind: 'success', text: '已清除失效关联；使用 /note on 开始新的笔记，不回填历史。' }
    }
    throw new Error(HELP)
  }

  async close() {
    this.closed = true
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)))
    await Promise.allSettled([...this.commands])
    await this.store.close()
  }
}
