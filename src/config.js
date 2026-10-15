import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** Loader configuration; all recording switches remain session-local and default off. */
export const Config = z.object({
  notesDir: z.string().default('~/.dsh/study-notes').description('笔记根目录；每个运行中的 DSH 请使用独立目录。'),
  debounceMs: z.number().step(1).min(0).max(60000).default(1500),
  timeoutMs: z.number().step(1).min(100).max(600000).default(60000),
  maxInputBytes: z.number().step(1).min(1024).max(1048576).default(98304),
  maxOutputBytes: z.number().step(1).min(1024).max(1048576).default(65536),
  maxOutputTokens: z.number().step(1).min(256).max(32768).default(4000),
  recentSections: z.number().step(1).min(1).max(30).default(6),
  maxMessageChars: z.number().step(1).min(100).max(100000).default(12000),
  provider: z.string().description('可选：与 model 一起指定整理模型；默认沿用这轮回答的模型。'),
  model: z.string(),
})

/** Resolve paths once and reject an incomplete auxiliary model override. */
export function resolveConfig(input = {}) {
  const result = Config['~standard'].validate(input)
  if (result.issues) throw new Error(result.issues.map(issue => issue.message).join('; '))
  const config = result.value
  if ((config.provider !== undefined || config.model !== undefined)
    && (!config.provider?.trim() || !config.model?.trim())) {
    throw new Error('study-note: provider 和 model 必须同时提供且非空。')
  }
  let root = config.notesDir
  if (root === '~') root = homedir()
  else if (/^~[/\\]/u.test(root)) root = resolve(homedir(), root.slice(2))
  if (!isAbsolute(root)) throw new Error('study-note: notesDir 必须是绝对路径或以 ~/ 开头。')
  return Object.freeze({ ...config, notesDir: resolve(root) })
}
