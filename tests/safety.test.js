import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, model, decision, session, command, turn, sync } from './helpers.js'
import { NoteStore } from '../src/store.js'
import { generate, validateDecision } from '../src/model.js'
import { resolveConfig } from '../src/config.js'

test('config rejects relative paths, invalid limits, and one-sided model overrides', () => {
  assert.throws(() => resolveConfig({ notesDir: './notes' }), /绝对路径/u)
  assert.throws(() => resolveConfig({ timeoutMs: -1 }))
  assert.throws(() => resolveConfig({ provider: 'x' }), /同时/u)
  assert.throws(() => resolveConfig({ provider: '', model: '' }), /非空/u)
})

test('model output rejects missing fields, comments, and unsafe ids', () => {
  assert.throws(() => validateDecision({ action: 'create' }))
  assert.throws(() => validateDecision(decision({ explanation: '<!-- injection -->' })))
  assert.throws(() => validateDecision(decision({ action: 'update', sectionId: '../../bad' })))
})

for (const finish of ['error', 'max-tokens', 'aborted', undefined]) {
  test(`LLM ${finish ?? 'missing'} finish never saves partial JSON`, async () => {
    const llm = { async * stream() {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(decision()) }
      if (finish) yield { type: 'finish', reason: { kind: finish } }
    } }
    await assert.rejects(generate(llm, {}, new AbortController().signal, 65536), /未正常完成/u)
  })
}

test('block-end text is not duplicated with preceding deltas', async () => {
  const text = JSON.stringify(decision())
  const llm = { async * stream() {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  assert.equal((await generate(llm, {}, new AbortController().signal, 65536)).action, 'create')
})

test('LLM output is bounded including multibyte chunks', async () => {
  const llm = { async * stream() { yield { type: 'text-delta', index: 0, text: '字'.repeat(1000) } } }
  await assert.rejects(generate(llm, {}, new AbortController().signal, 1024), /maxOutputBytes/u)
})

test('a failed dispatch retains its checkpoint for explicit retry and exposes status', async t => {
  const llm = model((request, count) => { if (count === 1) throw new Error('provider unavailable'); return decision() })
  const { recorder } = await fixture(t, llm)
  const chat = session('retry')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat))
  assert.equal((await command(recorder, chat, 'sync')).kind, 'error')
  assert.match((await command(recorder, chat, 'status')).text, /provider unavailable/u)
  await sync(recorder, chat)
  assert.equal((await recorder.store.documents()).length, 1)
})

test('prompt log exists before dispatch and does not include keys or ambient env', async t => {
  let root
  const llm = model(async request => {
    const files = await fs.readdir(join(root, '.study-note', 'requests'))
    assert.equal(files.length, 1)
    const audit = JSON.parse(await fs.readFile(join(root, '.study-note', 'requests', files[0]), 'utf8'))
    assert.deepEqual(audit.request.messages, request.messages)
    assert.deepEqual(Object.keys(audit.request).sort(), ['maxTokens', 'messages', 'model', 'provider', 'sessionId', 'system'])
    return decision()
  })
  const f = await fixture(t, llm); root = f.root
  const chat = session('audit')
  await command(f.recorder, chat, 'on')
  f.recorder.observe(chat, turn(chat)); await sync(f.recorder, chat)
})

test('unknown model topic cannot escape the root', async t => {
  const { recorder } = await fixture(t, model(() => decision({ topic: '../../escape' })))
  const chat = session('escape')
  await command(recorder, chat, 'on')
  assert.equal((await command(recorder, chat, 'topic ../../escape')).kind, 'error')
  recorder.observe(chat, turn(chat)); await sync(recorder, chat)
  assert.match((await recorder.store.documents())[0].path, /[/\\]inbox[/\\]/u)
})

test('symlinked topic is never written through', async t => {
  const { recorder, root, directory } = await fixture(t)
  const chat = session('symlink')
  await command(recorder, chat, 'on')
  const outside = join(directory, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, join(root, 'escape'))
  const result = await command(recorder, chat, 'topic escape')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /符号链接/u)
  assert.deepEqual(await fs.readdir(outside), [])
})

test('malformed index markers refuse replacement of handwritten README', async t => {
  const { recorder, root } = await fixture(t)
  const chat = session('bad-index')
  await command(recorder, chat, 'on')
  const text = '# My index\n<!-- dsh-study-note:index:start -->\nhandwritten'
  await fs.writeFile(join(root, 'README.md'), text)
  assert.equal((await command(recorder, chat, 'reindex')).kind, 'error')
  assert.equal(await fs.readFile(join(root, 'README.md'), 'utf8'), text)
})

test('single-writer lock prevents two instances from overwriting one knowledge base', async t => {
  const { recorder, root } = await fixture(t)
  await command(recorder, session('first'), 'on')
  const other = new NoteStore(root)
  await other.open()
  await assert.rejects(other.update('second', { enabled: true, epoch: 1, lastSeq: -1 }), /已被占用/u)
  await other.close()
})

test('state corruption is reported rather than overwritten', async t => {
  const { recorder, root } = await fixture(t)
  await command(recorder, session('state'), 'on')
  await fs.writeFile(join(root, '.study-note', 'state.json'), '{broken')
  const other = new NoteStore(root)
  await assert.rejects(other.open())
  assert.equal(await fs.readFile(join(root, '.study-note', 'state.json'), 'utf8'), '{broken')
})

test('state directory symlink is rejected before reading or writing', async t => {
  const { root, directory } = await fixture(t)
  const outside = join(directory, 'outside-state')
  await fs.mkdir(outside)
  await fs.mkdir(root)
  await fs.symlink(outside, join(root, '.study-note'))
  await assert.rejects(new NoteStore(root).open(), /符号链接/u)
  assert.deepEqual(await fs.readdir(outside), [])
})

test('a stale read-only instance refuses to overwrite newer state after the writer exits', async t => {
  const { recorder, root } = await fixture(t)
  const stale = new NoteStore(root)
  await stale.open()
  await command(recorder, session('newer'), 'on')
  await recorder.close()
  await assert.rejects(stale.update('stale', { enabled: true }), /重新加载/u)
  const saved = JSON.parse(await fs.readFile(join(root, '.study-note/state.json'), 'utf8'))
  assert.equal(saved.sessions.newer.enabled, true)
  assert.equal(saved.sessions.stale, undefined)
})

test('a failed on-topic remains disabled and its durable state can be reopened', async t => {
  const { recorder, root } = await fixture(t)
  await fs.mkdir(root)
  await fs.writeFile(join(root, 'README.md'), '<!-- dsh-study-note:index:start -->\n')
  const chat = session('failed-on')
  assert.equal((await command(recorder, chat, 'on topic')).kind, 'error')
  assert.equal(recorder.flag(chat.id).enabled, false)
  const reopened = new NoteStore(root)
  await reopened.open()
  assert.equal(reopened.get(chat.id).enabled, false)
})

test('index failure is retried without redispatching a committed turn', async t => {
  const { recorder, root, llm } = await fixture(t)
  const chat = session('retry-index')
  await command(recorder, chat, 'on')
  await fs.writeFile(join(root, 'README.md'), '<!-- dsh-study-note:index:start -->\n')
  recorder.observe(chat, turn(chat))
  assert.equal((await command(recorder, chat, 'sync')).kind, 'error')
  assert.equal(llm.calls.length, 1)
  await fs.writeFile(join(root, 'README.md'), '# Restored index\n')
  await sync(recorder, chat)
  assert.equal(llm.calls.length, 1)
  assert.match(await fs.readFile(join(root, 'README.md'), 'utf8'), /Cordis/u)
  assert.equal(recorder.store.get(chat.id).lastError, null)
})

test('control commands are ordered and off wins after a concurrent on', async t => {
  const { recorder } = await fixture(t)
  const chat = session('concurrent-controls')
  const results = await Promise.all([command(recorder, chat, 'on'), command(recorder, chat, 'off')])
  assert.ok(results.every(result => result.kind === 'success'))
  assert.equal(recorder.flag(chat.id).enabled, false)
  assert.equal(recorder.store.get(chat.id).enabled, false)
})

test('failed topic change preserves the enabled state', async t => {
  const { recorder, root, directory } = await fixture(t)
  const chat = session('failed-topic')
  await command(recorder, chat, 'on')
  await fs.symlink(directory, join(root, 'bad-topic'))
  assert.equal((await command(recorder, chat, 'topic bad-topic')).kind, 'error')
  assert.equal(recorder.flag(chat.id).enabled, true)
  assert.equal(recorder.store.get(chat.id).enabled, true)
  recorder.observe(chat, turn(chat))
  await sync(recorder, chat)
  assert.equal((await recorder.store.documents()).length, 1)
})
