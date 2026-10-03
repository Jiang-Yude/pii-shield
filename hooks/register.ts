import type { Register } from 'claude-code'

// Placeholders use 〔〕 so they never collide with ordinary text.
// Every masking hook fails closed: if masking throws, the text is withheld, not sent as is.
const AUTO_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Z][1289]\d{8}/g, '〔身分證號〕'],
  [/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '〔手機號碼〕'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '〔Email〕'],
]

const MEDIA = /\.(pdf|png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
const FAILED = '〔個資防護盾：遮蔽失敗，這段內容沒有送給 AI〕'

type Entry = { real: string; alias: string }

let entries: Entry[] | undefined
let missing = false
let restore = true
let namesFile = 'names.txt'

function parseNames(text: string): Entry[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const parsed = lines.map((line, i) => {
    const [real, alias] = line.split('=').map(s => s.trim())
    return { real, alias: alias ? `〔${alias}〕` : `〔保護對象${String(i + 1).padStart(2, '0')}〕` }
  })
  // Longest first, so 王小明 is replaced before 小明.
  return parsed.filter(e => e.real.length > 0).sort((a, b) => b.real.length - a.real.length)
}

async function load($: any): Promise<Entry[]> {
  if (entries) return entries
  const path = namesFile.startsWith('/') ? namesFile : `${$.plugin.root}/${namesFile}`
  if (!(await $.fs.exists(path))) {
    missing = true
    entries = []
    return entries
  }
  entries = parseNames(await $.fs.read(path))
  missing = false
  return entries
}

function mask(text: string, list: Entry[]): string {
  let out = text
  for (const { real, alias } of list) out = out.split(real).join(alias)
  for (const [re, label] of AUTO_PATTERNS) out = out.replace(re, label)
  return out
}

function unmask(text: string, list: Entry[]): string {
  let out = text
  for (const { real, alias } of list) out = out.split(alias).join(real)
  return out
}

function deep(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => deep(v, fn))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, fn)]))
  }
  return value
}

function maskBlocks(content: readonly any[], fn: (s: string) => string): any[] {
  return content.map(block => {
    if (block.type === 'text') return { ...block, text: fn(block.text) }
    if (block.type === 'tool_result') {
      const inner = block.content
      if (typeof inner === 'string') return { ...block, content: fn(inner) }
      if (Array.isArray(inner)) return { ...block, content: maskBlocks(inner, fn) }
    }
    return block
  })
}

export const register: Register = (on, options) => {
  if (typeof options.namesFile === 'string' && options.namesFile.trim()) namesFile = options.namesFile.trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pii-shield',
      description: 'Show 個資防護盾 status; "reload" re-reads names.txt; "restore on|off" toggles writing real names back into tool calls',
    })
    const list = await load($)
    $.ui.status(missing ? '個資防護盾：沒有 names.txt' : `個資防護盾：保護 ${list.length} 個名字`)
    return next(e)
  })

  on('command.run', { command: 'pii-shield' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reload') entries = undefined
    if (arg === 'restore on') restore = true
    if (arg === 'restore off') restore = false
    const list = await load($)
    $.ui.status(missing ? '個資防護盾：沒有 names.txt' : `個資防護盾：保護 ${list.length} 個名字`)
    return {
      text: missing
        ? '個資防護盾：找不到 names.txt，目前只遮身分證號、手機與 Email。'
        : `個資防護盾：保護 ${list.length} 個名字，寫回真名${restore ? '開啟' : '關閉'}。`,
    }
  })

  // What the person types, before it is queued or stored.
  on('prompt.submit', async ($, e, next) => {
    const list = await load($)
    return next({
      ...e,
      text: mask(e.text, list),
      ...(e.context ? { context: e.context.map(c => mask(c, list)) } : {}),
    })
  }).catch(($, e, next) => next({ ...e, text: FAILED, ...(e.context ? { context: [] } : {}) }))

  // Every row the model will read: replies, tool results, reminders, compaction summaries.
  on('session.append', async ($, e, next) => {
    const list = await load($)
    return next({ ...e, message: { ...e.message, content: maskBlocks(e.message.content, s => mask(s, list)) } })
  }).catch(($, e, next) =>
    next({ ...e, message: { ...e.message, content: maskBlocks(e.message.content, () => FAILED) } }),
  )

  // CLAUDE.md, memory and other context the engine prepends.
  on('prompt.context', async ($, e, next) => {
    const list = await load($)
    return next({ ...e, blocks: e.blocks.map(b => ({ ...b, text: mask(b.text, list) })) })
  }).catch(($, e, next) => next({ ...e, blocks: e.blocks.map(b => ({ ...b, text: FAILED })) }))

  on('prompt.section', async ($, e, next) => {
    const list = await load($)
    return next({ ...e, text: e.text === null ? null : mask(e.text, list) })
  }).catch(($, e, next) => next({ ...e, text: e.text === null ? null : FAILED }))

  on('prompt.attachment', async ($, e, next) => {
    const list = await load($)
    return next({ ...e, text: mask(e.text, list) })
  }).catch(($, e, next) => next({ ...e, text: FAILED }))

  // Images and PDFs reach the model as media, which cannot be rewritten.
  on('tool.call', { tool: 'Read' }, async ($, e, next) =>
    MEDIA.test(e.file_path)
      ? { deny: '個資防護盾：圖片與 PDF 裡的名字無法遮蔽，請先轉成文字檔再讀。' }
      : next(e),
  )

  // The model writes placeholders; put the real names back so edits match the files.
  on('tool.call', async ($, e, next) => {
    if (!restore) return next(e)
    const list = await load($)
    const { tool, tool_use_id, agentId, consent, ...args } = e as any
    return next({ ...e, ...(deep(args, s => unmask(s, list)) as object) } as any)
  })
}
