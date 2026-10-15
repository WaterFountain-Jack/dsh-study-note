import { Config, resolveConfig } from './config.js'
import { Recorder } from './recorder.js'

export { Config }
export const name = 'study-note'
export const inject = ['commands', 'sessions', 'llm']

/** Mount the human command and event observer; teardown removes listeners before draining work. */
export async function apply(ctx, input) {
  const recorder = new Recorder(resolveConfig(input), ctx.llm, ctx.logger)
  await recorder.open()
  ctx.effect(() => () => recorder.close())
  ctx.on('session/event', (session, event) => {
    if (session.header.origin !== 'subagent') recorder.observe(session, event)
  })
  ctx.on('session/created', session => {
    if (session.header.origin !== 'subagent') recorder.resume(session)
  })
  ctx.effect(() => ctx.commands.register({
    name: 'note',
    description: '当前对话学习笔记：on / off / status / sync / topic / reindex',
    input: { hint: 'on [分类] | off | status | sync | topic <分类> | reindex' },
    handler: invocation => recorder.command(invocation),
  }))
  for (const session of ctx.sessions.list()) {
    if (session.header.origin !== 'subagent') recorder.resume(session)
  }
}
