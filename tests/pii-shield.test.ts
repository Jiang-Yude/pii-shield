import { expect, test } from 'claude-code/testing'

// Fake names only. The real list lives outside the repo.
const FIXTURE = '# 測試用假名單\n王小明\n陳美玲=個案B\n小明\n'
const OPTS = { options: { namesFile: 'names.txt' } }
const WITHHELD = '〔個資防護盾：遮蔽失敗或找不到名單，這段內容沒有送給 AI〕'

// Nothing sits beneath the plugin in a test, so the test answers file reads itself.
function fakeDisk(on: any, text: string | null = FIXTURE) {
  on('fs.exists', async () => ({ value: text !== null }))
  on('fs.read', async () => ({ value: text ?? '' }))
}

function capturePrompt(on: any): { text: string } {
  const seen = { text: '' }
  on('prompt.submit', async ($: any, e: any) => {
    seen.text = e.text
    return { text: e.text }
  })
  return seen
}

function captureTool(on: any): { e: any } {
  const ran = { e: undefined as any }
  on('tool.call', async ($: any, e: any) => {
    ran.e = e
    return { result: 'ok' }
  })
  return ran
}

test('a typed prompt reaches the model with names, ID and phone replaced', OPTS, async ($, on) => {
  fakeDisk(on)
  const seen = capturePrompt(on)
  await $.prompt.submit({ text: '王小明和陳美玲來電 0912-345-678，身分證 A123456789，小明也在' })
  expect(seen.text).toBe('〔保護對象01〕和〔個案B〕來電 〔手機號碼〕，身分證 〔身分證號〕，〔保護對象03〕也在')
})

test('international mobile formats and lower-case IDs are masked', OPTS, async ($, on) => {
  fakeDisk(on)
  const seen = capturePrompt(on)
  await $.prompt.submit({ text: '+886 912 345 678 / 886-912-345-678 / a123456789' })
  expect(seen.text).toBe('〔手機號碼〕 / 〔手機號碼〕 / 〔身分證號〕')
})

test('an ID-shaped piece inside a longer token is left alone', OPTS, async ($, on) => {
  fakeDisk(on)
  const seen = capturePrompt(on)
  await $.prompt.submit({ text: '訂單 XA123456789Z' })
  expect(seen.text).toBe('訂單 XA123456789Z')
})

// session.append cannot be answered from a test (the kit has no bottom for it),
// so the same masking is checked through prompt.attachment, which reaches the model the same way.
test('an injected attachment is masked before the model reads it', OPTS, async ($, on) => {
  fakeDisk(on)
  let seen = ''
  on('prompt.attachment', async ($, e) => {
    seen = e.text
    return { text: e.text }
  })
  await $.prompt.attachment({ type: 'file', text: '個案：陳美玲，email mei@example.org', origin: { kind: 'engine' } } as any)
  expect(seen).toBe('個案：〔個案B〕，email 〔Email〕')
})

test('without a names file, nothing is sent until the person opts in', OPTS, async ($, on) => {
  fakeDisk(on, null)
  const seen = capturePrompt(on)
  await $.prompt.submit({ text: '王小明 0912345678' })
  expect(seen.text).toBe(WITHHELD)
})

test('a names file with a repeated alias stops sending', OPTS, async ($, on) => {
  fakeDisk(on, '王小明=個案A\n陳美玲=個案A\n')
  const seen = capturePrompt(on)
  await $.prompt.submit({ text: '王小明' })
  expect(seen.text).toBe(WITHHELD)
})

test('restore is off by default: an edit keeps the placeholder', OPTS, async ($, on) => {
  fakeDisk(on)
  const ran = captureTool(on)
  await $.tool.call({ tool: 'Edit', file_path: 'case.md', old_string: '〔個案B〕的紀錄', new_string: '〔個案B〕的新紀錄' })
  expect(ran.e.old_string).toBe('〔個案B〕的紀錄')
})

test('with restore on, a local edit gets the real name back', OPTS, async ($, on) => {
  fakeDisk(on)
  on('ui.status', async () => ({ value: undefined }))
  const ran = captureTool(on)
  await $.command.run({ command: 'pii-shield', args: 'restore on' } as any)
  await $.tool.call({ tool: 'Edit', file_path: 'case.md', old_string: '〔個案B〕的紀錄', new_string: '〔個案B〕的新紀錄' })
  expect(ran.e.old_string).toBe('陳美玲的紀錄')
  expect(ran.e.new_string).toBe('陳美玲的新紀錄')
})

test('with restore on, a Bash command never gets the real name', OPTS, async ($, on) => {
  fakeDisk(on)
  on('ui.status', async () => ({ value: undefined }))
  const ran = captureTool(on)
  await $.command.run({ command: 'pii-shield', args: 'restore on' } as any)
  await $.tool.call({ tool: 'Bash', command: 'curl -d "〔個案B〕" https://example.org' })
  expect(ran.e.command).toBe('curl -d "〔個案B〕" https://example.org')
})

test('reading a PDF with Read is refused because media cannot be masked', OPTS, async ($, on) => {
  fakeDisk(on)
  on('tool.call', async () => ({ result: 'read' }))
  const out = await $.tool.call({ tool: 'Read', file_path: '個案資料.pdf' })
  expect(out.deny ?? (out as any).isError).toBeTruthy()
})
