/** Text only: reasoning, tool results, images, and plugin-injected context are excluded. */
export function messageText(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
}

/** Exact control/status prompts are not independent learning questions. */
export function isRoutine(text) {
  return /^(?:继续(?:执行|讲|讲解)?|好的?|谢谢|收到|明白了?|下载(?:好|完|完成)了吗|进度如何|现在进度|continue|thanks|ok)[。！!？?\s]*$/iu.test(text.trim())
}

/** Select completed human-led turns after opt-in, never inherited or half-completed turns. */
export function collectTurns(session, fromSeq, toSeq) {
  const turns = []
  let current
  for (const event of session.events) {
    if (event.seq <= fromSeq || event.seq > toSeq) continue
    if (event.type === 'turn/start') current = { turn: event.data.turn, questions: [], answers: [], seqs: [] }
    if (!current) continue
    if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source?.kind === 'user') {
      const text = messageText(event.data)
      if (text) { current.questions.push(text); current.seqs.push(event.seq) }
    }
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && !event.data.interrupted) {
      const message = event.data.message
      if (!message.content.some(block => block.type === 'tool-call')) {
        const text = messageText(message)
        if (text) { current.answers.push({ text, route: message.source }); current.seqs.push(event.seq) }
      }
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'completed' && current.questions.length && current.answers.length) {
        const last = current.answers.at(-1)
        const question = current.questions.join('\n\n')
        if (!isRoutine(question)) turns.push({
          turn: current.turn, question, answer: last.text, sourceSeqs: current.seqs,
          endSeq: event.seq, route: { provider: last.route.provider, model: last.route.model },
        })
      }
      current = undefined
    }
  }
  return turns
}
