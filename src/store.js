import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const DOCUMENT = '<!-- dsh-study-note:document '
const INDEX_START = '<!-- dsh-study-note:index:start -->'
const INDEX_END = '<!-- dsh-study-note:index:end -->'
const SECTION = /<!-- dsh-study-note:section:([a-f0-9]{16}):start -->\n([\s\S]*?)<!-- dsh-study-note:section:\1:end -->/gu

export const digest = text => createHash('sha256').update(text).digest('hex')
export const validTopic = text => typeof text === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(text)
const line = text => text.replace(/[\r\n]/gu, ' ').replace(/</gu, '&lt;').trim()
const slug = text => text.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 50) || '学习笔记'
const label = text => line(text).replace(/([\\[\]])/gu, '\\$1')

async function optionalText(path) {
  try { return await fs.readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function parseDocument(text, path) {
  const first = text.split('\n', 1)[0]
  if (!first.startsWith(DOCUMENT) || !first.endsWith(' -->')) return undefined
  const meta = JSON.parse(first.slice(DOCUMENT.length, -4))
  if (meta.version !== 1 || typeof meta.sessionId !== 'string' || !Array.isArray(meta.sections)
    || !Number.isSafeInteger(meta.lastEndSeq) || typeof meta.title !== 'string'
    || (meta.summary !== undefined && typeof meta.summary !== 'string')
    || meta.sections.some(item => !item || !/^[a-f0-9]{16}$/u.test(item.id)
      || !/^[a-f0-9]{64}$/u.test(item.hash) || !Array.isArray(item.sourceSeqs)
      || item.sourceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0)
      || !Array.isArray(item.turns) || item.turns.some(turn => !Number.isSafeInteger(turn)))) {
    throw new Error(`study-note: 笔记元数据损坏：${path}`)
  }
  const sections = [...text.matchAll(SECTION)].map(match => ({ id: match[1], text: match[2], full: match[0] }))
  if (sections.length !== meta.sections.length || new Set(sections.map(section => section.id)).size !== sections.length
    || new Set(meta.sections.map(section => section.id)).size !== meta.sections.length
    || sections.some(section => !meta.sections.some(item => item.id === section.id))) {
    throw new Error(`study-note: 小节标记缺失或重复：${path}；请恢复注释标记后重试。`)
  }
  return { path, text, meta, sections }
}

function renderSection(value, sources) {
  return [
    `## ${line(value.title)}`, '', '### ❓ 问题', '', value.question, '',
    '### ✅ 一句话结论', '', value.conclusion, '',
    '### 💡 解释', '', value.explanation || '暂无补充。', '',
    '### 🔑 公式 / 代码 / 例子', '', value.example || '暂无。', '',
    '### 我的理解（待自己复述）', '', '> 以下为 AI 起草，尚未经用户复述确认。', '', value.understandingDraft || '待补充。', '',
    '### 关联 / 遗留疑问', '', ...(value.openQuestions.length ? value.openQuestions.map(item => `- ${item}`) : ['- 暂无；不代表已经掌握。']), '',
    `来源：本对话第 ${sources.turns.join('、')} 轮；消息事件 ${sources.sourceSeqs.map(seq => `#${seq}`).join('、')}。`, '',
  ].join('\n')
}

/** Local durable state, bounded Markdown scanning, and a single-writer lock per notes root. */
export class NoteStore {
  constructor(root) {
    this.root = resolve(root)
    this.state = { version: 1, sessions: {} }
    this.tail = Promise.resolve()
    this.lockToken = undefined
  }

  async open() {
    const text = await optionalText(await this.safePath('.study-note/state.json'))
    this.stateText = text
    if (!text) return
    const value = JSON.parse(text)
    if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) {
      throw new Error('study-note: state.json 格式不受支持；不会覆盖。')
    }
    for (const item of Object.values(value.sessions)) {
      if (!item || typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.epoch)
        || !Number.isSafeInteger(item.lastSeq) || item.lastSeq < -1
        || (item.topic !== undefined && !validTopic(item.topic))
        || (item.notePath !== undefined && typeof item.notePath !== 'string')) throw new Error('study-note: 会话状态损坏。')
      if (item.notePath) this.path(item.notePath)
    }
    this.state = value
  }

  get(id) { return Object.hasOwn(this.state.sessions, id) ? this.state.sessions[id] : undefined }

  /** Serialize every persistent mutation, including off and note/index commits. */
  serial(task) {
    const next = this.tail.then(task)
    this.tail = next.catch(() => {})
    return next
  }

  path(part) {
    const path = resolve(this.root, part)
    if (path === this.root || !path.startsWith(this.root + sep)) throw new Error('study-note: 文件路径越过 notesDir。')
    return path
  }

  async safePath(part, createParent = false) {
    const path = this.path(part)
    const parts = relative(this.root, path).split(sep)
    if (createParent) await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error(`study-note: 拒绝跟随符号链接：${this.root}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    let current = this.root
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index])
      let stat
      try { stat = await fs.lstat(current) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (createParent && index < parts.length - 1) await fs.mkdir(current, { mode: 0o700 })
        continue
      }
      if (stat.isSymbolicLink()) throw new Error(`study-note: 拒绝跟随符号链接：${current}`)
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`study-note: 不是目录：${current}`)
      if (index === parts.length - 1 && !stat.isFile()) throw new Error(`study-note: 不是普通文件：${current}`)
    }
    return path
  }

  async acquire() {
    if (this.lockToken) return
    const path = await this.safePath('.study-note/writer.lock', true)
    const token = randomUUID()
    let handle
    try { handle = await fs.open(path, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`study-note: ${path} 已被占用。请勿让两个 DSH 写入同一目录；崩溃遗留的锁须确认原进程已退出后再删除。`)
      throw error
    }
    try {
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync() } finally { await handle.close() }
      if (await optionalText(await this.safePath('.study-note/state.json')) !== this.stateText) {
        throw new Error('study-note: 状态在加载后已被其他写入者修改；请重新加载插件。')
      }
      this.lockToken = token
    } catch (error) {
      await fs.unlink(path)
      throw error
    }
  }

  async write(part, text, expected) {
    await this.acquire()
    const path = await this.safePath(part, true)
    if (arguments.length >= 3 && await optionalText(path) !== expected) throw new Error(`study-note: 文件已被外部修改，请重试：${path}`)
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    const handle = await fs.open(temp, 'wx', 0o600)
    try {
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      if (arguments.length >= 3 && await optionalText(path) !== expected) throw new Error(`study-note: 文件已被外部修改，请重试：${path}`)
      await fs.rename(temp, path)
    } catch (error) {
      await fs.unlink(temp)
      throw error
    }
  }

  async update(id, patch) {
    await this.acquire()
    const next = { version: 1, sessions: { ...this.state.sessions, [id]: { enabled: false, epoch: 0, lastSeq: -1, ...this.get(id), ...patch } } }
    const text = JSON.stringify(next, null, 2) + '\n'
    await this.write('.study-note/state.json', text, this.stateText)
    this.stateText = text
    this.state = next
    return this.get(id)
  }

  async topics() {
    let entries
    try { entries = await fs.readdir(this.root, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return ['inbox']
      throw error
    }
    return [...new Set(['inbox', ...entries.filter(entry => entry.isDirectory() && validTopic(entry.name)).map(entry => entry.name)])].sort()
  }

  /** Discover renamed/moved plugin documents; never follow directory or file symlinks. */
  async documents() {
    const documents = []
    let seen = 0
    const walk = async (directory, depth) => {
      if (depth > 4) return
      let entries
      try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (++seen > 20000) throw new Error('study-note: 索引目录超过 20000 个条目；请缩小 notesDir。')
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
          if ((await fs.stat(path)).size > 10 * 1024 * 1024) throw new Error(`study-note: Markdown 超过 10 MiB：${path}`)
          const document = parseDocument(await fs.readFile(path, 'utf8'), path)
          if (document) documents.push(document)
        }
      }
    }
    await walk(this.root, 0)
    return documents
  }

  async findDocument(id) {
    const matches = (await this.documents()).filter(document => document.meta.sessionId === id)
    if (matches.length > 1) throw new Error('study-note: 同一对话存在两份笔记，请移走重复副本后重试。')
    if (!matches.length && this.get(id)?.notePath) throw new Error('study-note: 笔记文件已删除或移出目录；无法继续写入，请恢复文件，或用 /note new 新建笔记。')
    return matches[0]
  }

  /** Preserve hand edits; an edited target receives a new supplemental section instead. */
  async saveDecision(id, turn, value, document, topics) {
    const state = this.get(id)
    const existing = value.action === 'update' ? document?.sections.find(section => section.id === value.sectionId) : undefined
    if (value.action === 'update' && !existing) throw new Error('study-note: 整理模型引用了不存在的小节。')
    const previous = existing && document.meta.sections.find(section => section.id === existing.id)
    const canReplace = previous && digest(existing.text) === previous.hash
    const sectionId = canReplace ? existing.id : randomUUID().replaceAll('-', '').slice(0, 16)
    const sources = {
      sourceSeqs: [...new Set([...(canReplace ? previous.sourceSeqs : []), ...turn.sourceSeqs])],
      turns: [...new Set([...(canReplace ? previous.turns : []), turn.turn])],
    }
    const content = renderSection(existing && !canReplace ? { ...value, title: `${value.title}（追问补充，保留原文手工修改）` } : value, sources)
    const section = `<!-- dsh-study-note:section:${sectionId}:start -->\n${content}<!-- dsh-study-note:section:${sectionId}:end -->`
    const sectionMeta = { id: sectionId, hash: digest(content), ...sources }
    const topic = state.topic ?? (topics.includes(value.topic) ? value.topic : 'inbox')
    const date = new Date().toISOString().slice(0, 10)
    const meta = {
      ...(document?.meta ?? { version: 1, sessionId: id, createdAt: new Date().toISOString(), title: line(value.documentTitle) }),
      summary: line(value.summary), lastEndSeq: turn.endSeq, updatedAt: new Date().toISOString(),
      sections: canReplace ? document.meta.sections.map(item => item.id === sectionId ? sectionMeta : item)
        : [...(document?.meta.sections ?? []), sectionMeta],
    }
    const part = document ? relative(this.root, document.path)
      : join(topic, `${date}-${slug(value.documentTitle)}-${digest(id).slice(0, 10)}.md`)
    let body = document ? document.text.slice(document.text.indexOf('\n') + 1)
      : `# ${line(value.documentTitle)}\n\n- 来源对话：\`${id.replaceAll('`', '')}\`\n- 自动整理：内容未经独立事实核验；“我的理解”是待改写草稿。\n\n`
    if (canReplace) body = body.replace(existing.full, section)
    else body = body.trimEnd() + '\n\n' + section + '\n'
    const output = `${DOCUMENT}${JSON.stringify(meta)} -->\n${body}`
    const current = await optionalText(await this.safePath(part, true))
    if (!document && current !== undefined) throw new Error('study-note: 目标文件已存在，不会覆盖。')
    await this.write(part, output, document?.text)
    await this.update(id, { notePath: part, lastSeq: turn.endSeq, lastSavedAt: meta.updatedAt, lastError: null })
    await this.reindex()
    return this.path(part)
  }

  /** Rebuild only the plugin-owned index block; handwritten README content is unchanged. */
  async reindex() {
    const documents = await this.documents()
    const entries = documents.map(document => {
      const path = relative(this.root, document.path).split(sep).join('/')
      const title = /^# (.+)$/mu.exec(document.text)?.[1] ?? document.meta.title
      return { path, title, topic: path.includes('/') ? path.split('/')[0] : 'inbox', summary: document.meta.summary }
    }).sort((left, right) => left.path.localeCompare(right.path))
    const lines = [INDEX_START, '## 自动学习笔记', '']
    let topic
    for (const entry of entries) {
      if (entry.topic !== topic) { lines.push(`### ${entry.topic}`, ''); topic = entry.topic }
      lines.push(`- [${label(entry.title)}](${entry.path.split('/').map(encodeURIComponent).join('/')}) — ${label(entry.summary ?? '')}`)
    }
    if (!entries.length) lines.push('暂无自动学习笔记。')
    lines.push('', INDEX_END)
    const part = 'README.md'
    const original = await optionalText(await this.safePath(part, true))
    const text = original ?? '# 学习笔记索引\n'
    const starts = text.split(INDEX_START).length - 1
    const ends = text.split(INDEX_END).length - 1
    if (starts !== ends || starts > 1 || (starts && text.indexOf(INDEX_END) < text.indexOf(INDEX_START))) {
      throw new Error('study-note: README 索引标记损坏；不会覆盖手工内容。')
    }
    const block = lines.join('\n')
    const next = starts ? text.slice(0, text.indexOf(INDEX_START)) + block + text.slice(text.indexOf(INDEX_END) + INDEX_END.length)
      : text + '\n' + block + '\n'
    if (next !== original) await this.write(part, next, original)
    return entries.length
  }

  async move(id, topic) {
    if (!validTopic(topic)) throw new Error('study-note: 分类限 1–64 位字母、汉字、数字、下划线或短横线。')
    await this.acquire()
    await this.safePath(join(topic, '.directory-check'), true)
    const document = await this.findDocument(id)
    if (document) {
      const target = join(topic, basename(document.path))
      if (this.path(target) !== document.path) {
        const destination = await this.safePath(target, true)
        if (await optionalText(destination) !== undefined) throw new Error('study-note: 分类目标文件已存在。')
        await this.acquire()
        await fs.rename(document.path, destination)
        await this.update(id, { notePath: target })
      }
    }
    await this.update(id, { topic })
    await this.reindex()
  }

  /** Release the single-writer lease only after all serialized writes settle. */
  async close() {
    await this.tail
    if (!this.lockToken) return
    const path = this.path('.study-note/writer.lock')
    const lock = JSON.parse(await fs.readFile(path, 'utf8'))
    if (lock.token !== this.lockToken) throw new Error('study-note: 写入锁所有者发生变化。')
    await fs.unlink(path)
    this.lockToken = undefined
  }
}
