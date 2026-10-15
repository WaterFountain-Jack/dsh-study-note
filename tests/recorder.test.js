import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join, basename } from 'node:path'
import { fixture, session, turn, append, command, sync, model, decision } from './helpers.js'
import { Recorder } from '../src/recorder.js'

test('disabled by default: events, status, and off create no files or LLM requests', async t => {
  const { recorder, llm, root } = await fixture(t)
  const chat = session('off-default')
  recorder.observe(chat, turn(chat))
  assert.match((await command(recorder, chat, 'status')).text, /关闭/u)
  await command(recorder, chat, 'off')
  assert.equal(llm.calls.length, 0)
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
})

test('records only future turns in the enabled conversation; maintains Markdown and index', async t => {
  const { recorder, llm, root } = await fixture(t)
  const a = session('enabled-a'), b = session('disabled-b')
  turn(a, '旧历史')
  assert.equal((await command(recorder, a, 'on dsh')).kind, 'success')
  recorder.observe(b, turn(b))
  recorder.observe(a, turn(a))
  await sync(recorder, a)
  assert.equal(llm.calls.length, 1)
  const files = await recorder.store.documents()
  assert.equal(files.length, 1)
  assert.match(files[0].path, /[/\\]dsh[/\\]/u)
  assert.match(files[0].text, /一句话结论/u)
  assert.match(files[0].text, /待自己复述/u)
  assert.doesNotMatch(JSON.stringify(llm.calls[0]), /旧历史|PRIVATE REASONING/u)
  assert.match(await fs.readFile(join(root, 'README.md'), 'utf8'), /自动学习笔记/u)
  assert.match(await fs.readFile(join(root, 'README.md'), 'utf8'), /Cordis/u)
})

test('follow-ups update the same section without duplicate notes or index rows', async t => {
  const llm = model(request => {
    const input = JSON.parse(request.messages[0].content[0].text)
    return input.existingSections.length ? decision({ action: 'update', sectionId: input.existingSections[0].id, conclusion: '函数引用与调用结果不同。' }) : decision()
  })
  const { recorder, root } = await fixture(t, llm)
  const chat = session('follow-up')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat))
  await sync(recorder, chat)
  recorder.observe(chat, turn(chat, 'callback() 又有什么区别？'))
  await sync(recorder, chat)
  const docs = await recorder.store.documents()
  assert.equal(docs.length, 1)
  assert.equal(docs[0].sections.length, 1)
  assert.match(docs[0].text, /函数引用与调用结果不同/u)
  assert.deepEqual(docs[0].meta.sections[0].turns, [1, 2])
  assert.equal((await fs.readFile(join(root, 'README.md'), 'utf8')).match(/^- \[/gmu).length, 1)
})

test('coalesced turns are all processed and repeated sync does not dispatch twice', async t => {
  const { recorder, llm } = await fixture(t)
  const chat = session('batch')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat, 'Context 是什么？'))
  recorder.observe(chat, turn(chat, 'Fiber 是什么？'))
  await sync(recorder, chat)
  await sync(recorder, chat)
  assert.equal(llm.calls.length, 2)
  assert.equal((await recorder.store.documents())[0].sections.length, 2)
})

test('routine prompts, synthetic user messages, and interrupted turns are skipped', async t => {
  const { recorder, llm } = await fixture(t)
  const chat = session('skip')
  await command(recorder, chat, 'on')
  for (const end of [turn(chat, '继续执行'), turn(chat, '下载完成了吗？'), turn(chat, '系统注入', 'xxx', { source: 'plugin' }), turn(chat, '未完成', 'xxx', { interrupted: true, reason: 'aborted' })]) recorder.observe(chat, end)
  await sync(recorder, chat)
  assert.equal(llm.calls.length, 0)
  assert.equal((await recorder.store.documents()).length, 0)
})

test('model may skip an unrelated task without creating a note', async t => {
  const { recorder } = await fixture(t, model(() => ({ action: 'skip', reason: '临时操作' })))
  const chat = session('semantic-skip')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat, '帮我打开文件'))
  await sync(recorder, chat)
  assert.equal((await recorder.store.documents()).length, 0)
})

test('off aborts generation; no late note commit; on again skips the off interval', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const llm = {
    calls: 0,
    async * stream({ signal }) {
      this.calls++
      entered()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      yield { type: 'text-delta', index: 0, text: JSON.stringify(decision()) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { recorder } = await fixture(t, llm)
  const chat = session('cancel')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat))
  const syncing = command(recorder, chat, 'sync')
  await started
  assert.equal((await command(recorder, chat, 'off')).kind, 'success')
  await syncing
  assert.equal((await recorder.store.documents()).length, 0)
  recorder.observe(chat, turn(chat, '关闭期间的问题'))
  assert.equal(llm.calls, 1)
  assert.equal(recorder.store.get(chat.id).enabled, false)
})

test('restart retains the opt-in and note identity; resumes unprocessed turns only', async t => {
  const { recorder, config, llm } = await fixture(t)
  const chat = session('restart')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat))
  await sync(recorder, chat)
  await recorder.close()
  turn(chat, '下一个知识点是什么？')
  const second = new Recorder(config, llm, { info() {}, warn() {} })
  await second.open()
  t.after(() => second.close())
  second.resume(chat)
  await sync(second, chat)
  assert.equal(llm.calls.length, 2)
  assert.equal((await second.store.documents()).length, 1)
  assert.equal((await second.store.documents())[0].sections.length, 2)
  await second.close()
})

test('off and on never backfill questions from the disabled interval', async t => {
  const { recorder, llm } = await fixture(t)
  const chat = session('gap')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat))
  await sync(recorder, chat)
  await command(recorder, chat, 'off')
  turn(chat, 'OFF INTERVAL')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat, '新的学习问题'))
  await sync(recorder, chat)
  assert.equal(llm.calls.length, 2)
  assert.doesNotMatch(JSON.stringify(llm.calls), /OFF INTERVAL/u)
})

test('manual edits inside a section are kept and follow-up is appended', async t => {
  const llm = model(request => {
    const input = JSON.parse(request.messages[0].content[0].text)
    return input.existingSections.length ? decision({ action: 'update', sectionId: input.existingSections[0].id }) : decision()
  })
  const { recorder } = await fixture(t, llm)
  const chat = session('manual')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat)); await sync(recorder, chat)
  const original = (await recorder.store.documents())[0]
  await fs.writeFile(original.path, original.text.replace('### 💡 解释', '我的手写理解\n\n### 💡 解释'))
  recorder.observe(chat, turn(chat, '继续解释这个区别')); await sync(recorder, chat)
  const note = (await recorder.store.documents())[0]
  assert.match(note.text, /我的手写理解/u)
  assert.equal(note.sections.length, 2)
  assert.match(note.text, /保留原文手工修改/u)
})

test('reindex preserves handwritten content and tracks renamed, moved, and removed notes', async t => {
  const { recorder, root } = await fixture(t)
  const chat = session('index')
  await command(recorder, chat, 'on')
  await fs.writeFile(join(root, 'README.md'), '# 我的知识库\n\n- [旧笔记](old.md)\n')
  recorder.observe(chat, turn(chat)); await sync(recorder, chat)
  const note = (await recorder.store.documents())[0]
  await fs.mkdir(join(root, 'typescript'))
  const target = join(root, 'typescript', '新名字.md')
  await fs.rename(note.path, target)
  await command(recorder, chat, 'reindex')
  const index = await fs.readFile(join(root, 'README.md'), 'utf8')
  assert.ok(index.startsWith('# 我的知识库\n\n- [旧笔记](old.md)\n'))
  assert.match(index, /typescript/u)
  assert.ok(index.includes(encodeURIComponent('新名字.md')))
  recorder.observe(chat, turn(chat, '再学一个概念')); await sync(recorder, chat)
  assert.equal((await recorder.store.documents())[0].path, target)
  await fs.unlink(target)
  await command(recorder, chat, 'reindex')
  assert.doesNotMatch(await fs.readFile(join(root, 'README.md'), 'utf8'), /typescript/u)
})

test('deleting a note does not recreate it silently; new explicitly resets the association', async t => {
  const { recorder } = await fixture(t)
  const chat = session('deleted')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat)); await sync(recorder, chat)
  await fs.unlink((await recorder.store.documents())[0].path)
  recorder.observe(chat, turn(chat, '新问题'))
  const failure = await command(recorder, chat, 'sync')
  assert.equal(failure.kind, 'error')
  assert.match(failure.text, /已删除/u)
  assert.equal((await recorder.store.documents()).length, 0)
  assert.equal((await command(recorder, chat, 'new')).kind, 'success')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat, '重新记录')); await sync(recorder, chat)
  assert.equal((await recorder.store.documents()).length, 1)
})

test('topic moves the document and updates the index', async t => {
  const { recorder, root } = await fixture(t)
  const chat = session('move')
  await command(recorder, chat, 'on')
  recorder.observe(chat, turn(chat)); await sync(recorder, chat)
  assert.equal((await command(recorder, chat, 'topic cordis')).kind, 'success')
  assert.equal(basename((await recorder.store.documents())[0].path).endsWith('.md'), true)
  assert.match((await recorder.store.documents())[0].path, /[/\\]cordis[/\\]/u)
  assert.match(await fs.readFile(join(root, 'README.md'), 'utf8'), /### cordis/u)
})

test('subagent conversations cannot opt in', async t => {
  const { recorder } = await fixture(t)
  const chat = session('child'); chat.header.origin = 'subagent'
  assert.equal((await command(recorder, chat, 'on')).kind, 'error')
})

test('opting in during a turn excludes that half-observed turn', async t => {
  const { recorder, llm } = await fixture(t)
  const chat = session('middle')
  append(chat, 'turn/start', { turn: 1 })
  append(chat, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '先前提问' }] }, 'append')
  await command(recorder, chat, 'on')
  append(chat, 'assistant/message', { message: { source: { provider: 'test', model: 'm' }, content: [{ type: 'text', text: '回答' }] } }, 'append')
  recorder.observe(chat, append(chat, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await sync(recorder, chat)
  assert.equal(llm.calls.length, 0)
})
