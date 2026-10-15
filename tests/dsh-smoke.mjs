import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decision } from './helpers.js'

// DSH services and Loader are real; only the external provider is replaced to avoid paid requests.
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const cliManifest = process.env.DSH_PACKAGE_JSON
  ? resolve(process.env.DSH_PACKAGE_JSON) : resolve(packageRoot, '../apps/cli/package.json')
const requireDsh = createRequire(cliManifest)
const load = async name => {
  let path
  try { path = requireDsh.resolve(name) } catch (error) {
    if (name !== '@deepseek-ai/dsh-commands' || process.env.DSH_PACKAGE_JSON) throw error
    path = resolve(packageRoot, '../packages/interaction/commands/lib/index.js')
  }
  return import(pathToFileURL(path).href)
}
const [{ Context }, { default: Loader }, { default: Include }, llmModule, sessionModule, commandsModule] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-commands',
].map(load))
const plugin = await import(pathToFileURL(resolve(process.env.STUDY_NOTE_ENTRY ?? join(packageRoot, 'src/index.js'))).href)
const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-study-note-loader-'))
const notesDir = join(directory, 'notes')
const ctx = new Context()
let calls = 0
let holdNext = false
let started
let dispatchStarted
class TestAdapter extends llmModule.LlmAdapter {
  async * stream(options) {
    calls++
    const files = await fs.readdir(join(notesDir, '.study-note/requests'))
    const audits = await Promise.all(files.map(async path => JSON.parse(await fs.readFile(join(notesDir, '.study-note/requests', path), 'utf8'))))
    assert.ok(audits.some(audit => audit.request.messages[0].id === options.messages[0].id))
    if (holdNext) {
      started()
      await new Promise(resolveAbort => {
        if (options.signal.aborted) resolveAbort()
        else options.signal.addEventListener('abort', resolveAbort, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted' } }
      return
    }
    const input = JSON.parse(options.messages[0].content[0].text)
    const value = input.existingSections.length
      ? decision({ action: 'update', sectionId: input.existingSections[0].id, explanation: 'effect 接收函数，由 Cordis 控制执行和清理。' }) : decision()
    yield { type: 'text-delta', index: 0, text: JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  const configPath = join(directory, 'cordis.yml')
  const rows = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-commands']
    .map(name => `- name: '${name}'`)
  rows.push(`- name: dsh-study-note\n  config:\n    notesDir: ${JSON.stringify(notesDir)}\n    debounceMs: 10`)
  await fs.writeFile(configPath, rows.join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([
    ['@deepseek-ai/dsh-llm', llmModule.default], ['@deepseek-ai/dsh-session', sessionModule.default],
    ['@deepseek-ai/dsh-commands', commandsModule.default], ['dsh-study-note', plugin],
  ])
  ctx.loader.internal = { version: 'v2', async import(name) {
    assert.ok(modules.has(name), `Unexpected Loader import: ${name}`)
    return modules.get(name)
  } }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  assert.deepEqual([...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber).map(entry => entry.options.name), [])
  assert.ok(ctx.commands, 'Command service must have loaded')
  const adapterRegistration = ctx.llm.registerAdapter(['test'], new TestAdapter())
  const chat = ctx.sessions.create(sessionModule.SessionId('loader-study-note'))
  const disabled = ctx.sessions.create(sessionModule.SessionId('loader-disabled'))
  const agent = { session: chat, ctx, id: 'smoke-agent' }
  const run = async command => {
    const execution = await ctx.commands.execute(agent, `/note ${command}`, [], new AbortController().signal)
    assert.equal(execution?.result.kind, 'success', execution?.result.text)
    return execution.result.text
  }
  const completeTurn = (session, question) => {
    const turn = session.events.filter(event => event.type === 'turn/start').length + 1
    session.append('turn/start', { turn })
    session.append('user/message', llmModule.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: question }] }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: llmModule.createAssistantMessage({ source: { provider: 'test', model: 'test-model' }, content: [{ type: 'text', text: 'callback 是交给框架调用的函数。' }] }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  assert.ok(ctx.commands.find(agent, 'note'))
  await run('status')
  await assert.rejects(fs.stat(notesDir), { code: 'ENOENT' })
  await run('on Cordis')
  completeTurn(chat, 'callback 是什么？')
  completeTurn(disabled, '这个问题不要记录')
  // Wait on observable output, not the event loop's idle state; no API key is involved.
  const deadline = Date.now() + 10000
  let state
  while (Date.now() < deadline) {
    state = JSON.parse(await fs.readFile(join(notesDir, '.study-note/state.json'), 'utf8'))
    if (state.sessions[chat.id].notePath) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  assert.ok(state.sessions[chat.id].notePath, 'Background turn/end observer must create the note')
  await run('sync')
  assert.equal(calls, 1)
  assert.equal(state.sessions[disabled.id], undefined)
  completeTurn(chat, 'ctx.effect(callback) 为什么不加括号？')
  await run('sync')
  assert.equal(calls, 2)
  const notePath = join(notesDir, state.sessions[chat.id].notePath)
  let note = await fs.readFile(notePath, 'utf8')
  assert.equal((note.match(/:start -->/gu) ?? []).length, 1)
  const snapshot = {
    command: '/note', disabledByDefault: true, backgroundRecorded: true, followupMerged: true,
    topic: dirname(state.sessions[chat.id].notePath),
    headings: [...note.matchAll(/^#{1,3} .+$/gmu)].map(match => match[0]),
    indexRows: (await fs.readFile(join(notesDir, 'README.md'), 'utf8')).split('\n')
      .filter(line => line.startsWith('- [')).map(line => line.replace(/\]\([^)]*\)/u, '](<note-path>)')),
    auxiliaryCalls: calls,
  }
  assert.deepEqual(snapshot, JSON.parse(await fs.readFile(new URL('./fixtures/loader-output.json', import.meta.url), 'utf8')))
  holdNext = true
  dispatchStarted = new Promise(resolveStarted => { started = resolveStarted })
  completeTurn(chat, '卸载时应该如何取消正在运行的整理？')
  let dispatchTimeout
  try {
    await Promise.race([dispatchStarted, new Promise((_, reject) => {
      dispatchTimeout = setTimeout(() => reject(new Error('Background dispatch timed out')), 10000)
    })])
  } finally { clearTimeout(dispatchTimeout) }
  const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-study-note')
  await entry.fiber.dispose()
  assert.equal(ctx.commands.find(agent, 'note'), undefined)
  assert.equal(await fs.readFile(notePath, 'utf8'), note)
  await assert.rejects(fs.stat(join(notesDir, '.study-note/writer.lock')), { code: 'ENOENT' })
  adapterRegistration()
  console.log(`Real DSH Loader smoke passed (${cliManifest}); output snapshot matched, disabled isolation and aborting disposal verified.`)
} finally {
  await ctx.fiber.dispose()
  await fs.rm(directory, { recursive: true, force: true })
}
