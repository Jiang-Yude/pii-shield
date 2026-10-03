import { expect, test } from 'claude-code/testing'

// Fake names only. The real list lives outside the repo.
const FIXTURE = '# 測試用假名單\n王小明\n陳美玲=個案B\n小明\n'
const OPTS = { options: { namesFile: 'names.txt' } }

// Nothing sits beneath the plugin in a test, so the test answers file reads itself.
function fakeDisk(on: any, text: string | null = FIXTURE) {
  on('fs.exists', async () => ({ value: text !== null }))
  on('fs.read', async () => ({ value: text ?? '' }))
}

test('a typed prompt reaches the model with names, ID and phone replaced', OPTS, async ($, on) => {
  fakeDisk(on)
  let seen = ''
  on('prompt.submit', async ($, e) => {
    seen = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: '王小明和陳美玲來電 0912-345-678，身分證 A123456789，小明也在' })
  expect(seen).toBe('〔保護對象01〕和〔個案B〕來電 〔手機號碼〕，身分證 〔身分證號〕，〔保護對象03〕也在')
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

test('placeholders in a tool call are turned back into real names', OPTS, async ($, on) => {
  fakeDisk(on)
  let ran: any
  on('tool.call', async ($, e) => {
    ran = e
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Edit', file_path: 'case.md', old_string: '〔個案B〕的紀錄', new_string: '〔個案B〕的新紀錄' })
  expect(ran.old_string).toBe('陳美玲的紀錄')
  expect(ran.new_string).toBe('陳美玲的新紀錄')
})

test('reading a PDF is refused because media cannot be masked', OPTS, async ($, on) => {
  fakeDisk(on)
  on('tool.call', async () => ({ result: 'read' }))
  const out = await $.tool.call({ tool: 'Read', file_path: '個案資料.pdf' })
  expect(out.deny ?? (out as any).isError).toBeTruthy()
})

test('without a names file, ID, phone and email are still masked', OPTS, async ($, on) => {
  fakeDisk(on, null)
  let seen = ''
  on('prompt.submit', async ($, e) => {
    seen = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: '王小明 0912345678 wang@example.org' })
  expect(seen).toBe('王小明 〔手機號碼〕 〔Email〕')
})
