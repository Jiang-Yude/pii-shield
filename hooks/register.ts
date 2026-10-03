import type { Register } from 'claude-code'

// Placeholders use 〔〕 so they never collide with ordinary text.
// Every masking hook fails closed: if masking throws, the text is withheld, not sent as is.
const AUTO_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Taiwan national ID and resident certificate numbers, either case, not inside a longer token
  [/(?<![A-Za-z0-9])[A-Za-z][1289A-Da-d]\d{8}(?![A-Za-z0-9])/g, '〔身分證號〕'],
  // Taiwan mobile numbers: 0912-345-678, 0912 345 678, +886 912 345 678, 886-912-345-678
  [/(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g, '〔手機號碼〕'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '〔Email〕'],
]

const MEDIA = /\.(pdf|png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
const FAILED = '〔個資防護盾：遮蔽失敗或名單無效，這段內容沒有送給 AI〕'

// Only these tools write to local files; real names are put back into these fields alone.
const WRITE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Edit: ['old_string', 'new_string'],
  Write: ['content'],
  MultiEdit: ['edits'],
  NotebookEdit: ['new_source'],
}

type Entry = { real: string; alias: string }

let entries: Entry[] | undefined
let missing = false
let loadError = ''
let restore = false
let allowEmpty = false
let namesFile = 'names.txt'

function parseNames(text: string): Entry[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const parsed = lines.map((line, i) => {
    const cut = line.indexOf('=')
    const real = (cut === -1 ? line : line.slice(0, cut)).trim()
    const alias = cut === -1 ? '' : line.slice(cut + 1).trim()
    return { real, alias: alias ? `〔${alias}〕` : `〔保護對象${String(i + 1).padStart(2, '0')}〕` }
  }).filter(e => e.real.length > 0)
  const aliases = new Set<string>()
  for (const { real, alias } of parsed) {
    if (aliases.has(alias)) throw new Error(`代號重複：${alias}`)
    aliases.add(alias)
    if (real.includes('〔') || real.includes('〕')) throw new Error('名字不能含〔〕')
  }
  // An alias that contains a protected name would put that name back into the text after masking.
  for (const { alias } of parsed) {
    for (const { real } of parsed) if (alias.includes(real)) throw new Error(`代號 ${alias} 含有保護名單上的名字`)
  }
  // Longest first, so 王小明 is replaced before 小明.
  return parsed.sort((a, b) => b.real.length - a.real.length)
}

async function load($: any): Promise<Entry[]> {
  if (entries) return entries
  const path = namesFile.startsWith('/') ? namesFile : `${$.plugin.root}/${namesFile}`
  if (!(await $.fs.exists(path))) {
    missing = true
    entries = []
    return entries
  }
  try {
    entries = parseNames(await $.fs.read(path))
    loadError = ''
  } catch (err) {
    loadError = (err as Error).message
    throw err
  }
  // A list with no names protects no one: treat it like a missing list.
  missing = entries.length === 0
  return entries
}

function mask(text: string, list: Entry[]): string {
  // Without a names list, refuse to send anything unless the person chose auto patterns only.
  if (missing && !allowEmpty) throw new Error('no names file')
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

function statusLine(count: number): string {
  if (loadError) return '個資防護盾：名單有錯，已停止送出'
  if (missing) return allowEmpty ? '個資防護盾：只遮號碼與 Email（未使用名單）' : '個資防護盾：找不到名單或名單是空的，已停止送出'
  return `個資防護盾：保護 ${count} 個名字`
}

export const register: Register = (on, options) => {
  if (typeof options.namesFile === 'string' && options.namesFile.trim()) namesFile = options.namesFile.trim()

  on('session.start', async ($, e, next) => {
    // Every session starts from the safe defaults, whatever an earlier session chose.
    entries = undefined
    missing = false
    loadError = ''
    restore = false
    allowEmpty = false
    await $.command.register({
      name: 'pii-shield',
      description: 'Show 個資防護盾 status; reload | restore on|off | no-names',
    })
    const list = await load($).catch(() => [])
    $.ui.status(statusLine(list.length))
    return next(e)
  })

  on('command.run', { command: 'pii-shield' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reload') {
      entries = undefined
      allowEmpty = false
    }
    let list: Entry[]
    try {
      list = await load($)
    } catch (err) {
      entries = undefined
      $.ui.status('個資防護盾：名單有錯，已停止送出')
      return { text: `個資防護盾：名單有錯（${(err as Error).message}），所有文字內容都不會送給 AI，這次的指令也沒有生效。改好後輸入 /pii-shield reload。` }
    }
    // Switches change only after the list loaded, so a failed command never changes the safety state.
    if (arg === 'restore on') restore = true
    if (arg === 'restore off') restore = false
    if (arg === 'no-names') {
      if (!missing) return { text: '個資防護盾：名單有效，不需要 no-names。' }
      allowEmpty = true
    }
    $.ui.status(statusLine(list.length))
    if (missing && !allowEmpty) {
      return { text: '個資防護盾：找不到名單或名單是空的，所有文字內容都不會送給 AI。請建立 names.txt 後輸入 /pii-shield reload；只想遮號碼與 Email 就輸入 /pii-shield no-names。' }
    }
    return { text: `${statusLine(list.length)}，寫回真名${restore ? '開啟' : '關閉'}。` }
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

  // Images and PDFs read with Read reach the model as media, which cannot be rewritten.
  // Text that a command extracts from them is ordinary tool output and is masked above.
  on('tool.call', { tool: 'Read' }, async ($, e, next) =>
    MEDIA.test(e.file_path)
      ? { deny: '個資防護盾：用 Read 讀圖片與 PDF 時無法遮蔽，請先轉成文字檔再讀。' }
      : next(e),
  )

  // Off by default. When on, real names go back only into local file writes,
  // never into Bash, web, MCP or subagent calls.
  on('tool.call', async ($, e, next) => {
    const fields = WRITE_FIELDS[(e as any).tool]
    if (!restore || !fields) return next(e)
    const list = await load($)
    const patch: Record<string, unknown> = {}
    for (const f of fields) if (f in (e as any)) patch[f] = deep((e as any)[f], s => unmask(s, list))
    return next({ ...e, ...patch } as any)
  })
}
