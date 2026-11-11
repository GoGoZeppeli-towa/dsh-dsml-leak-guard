import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, guardStream } from '../lib/index.js'

// U+FF5C FULLWIDTH VERTICAL LINE, the separator DeepSeek emits in DSML tags.
const BAR = '\u{FF5C}'
const D2 = BAR + BAR

/** </｜｜DSML｜｜ invoke> */
const CLOSE_INVOKE = `</${D2}DSML${D2} invoke>`
/** </｜｜DSML｜｜ calls> */
const CLOSE_CALLS = `</${D2}DSML${D2} calls>`

function textStream(text, { finish = 'stop' } = {}) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

async function collect(chunks) {
  const out = []
  async function* source() {
    for (const chunk of chunks) yield chunk
  }
  for await (const chunk of guardStream(source(), () => {})) out.push(chunk)
  return out
}

const textOf = (chunks) =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')

test('classify: real prose passes immediately', () => {
  assert.equal(classify('Hello'), 1)
  assert.equal(classify(`  ${BAR}`), 1)
})

test('classify: undecided while the marker is still ambiguous', () => {
  assert.equal(classify(''), 0)
  assert.equal(classify('  '), 0)
  assert.equal(classify('<'), 0)
  assert.equal(classify(`</${BAR}`), 0)
  assert.equal(classify(`</${D2}DSML`), 0)
  assert.equal(classify(`</${D2}DSML${D2}`), 2)
})

test('classify: single-bar and ASCII separators are recognised', () => {
  assert.equal(classify(`</${BAR}DSML${BAR} invoke>`), 2)
  assert.equal(classify('</||DSML|| invoke>'), 2)
})

test('clean prose is passed through unchanged', async () => {
  const input = textStream('The answer is 42.')
  const out = await collect(input)
  assert.deepEqual(out, input)
})

test('a block made only of DSML tags is dropped and the turn becomes retryable', async () => {
  const chunks = await collect(textStream(`${CLOSE_INVOKE}\n${CLOSE_CALLS}`))
  assert.equal(textOf(chunks), '')
  assert.equal(chunks.some((c) => c.type === 'block-start'), false)
  assert.equal(chunks.some((c) => c.type === 'block-end'), false)
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('DSML detection works when the marker is split across deltas', async () => {
  const pieces = ['<', `/${BAR}`, `${BAR}DSML`, `${D2} invoke>`, '\n', CLOSE_CALLS]
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...pieces.map((text) => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const chunks = await collect(input)
  assert.equal(textOf(chunks), '')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('a block that carries prose and DSML tags together is passed through', async () => {
  const chunks = await collect(textStream(`done. ${CLOSE_INVOKE}`))
  assert.equal(textOf(chunks), `done. ${CLOSE_INVOKE}`)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a dropped block does not swallow a following tool call', async () => {
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: CLOSE_CALLS },
    { type: 'block-end', index: 0, block: { type: 'text', text: CLOSE_CALLS } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'bash', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-call' } },
  ]
  const chunks = await collect(input)
  assert.equal(textOf(chunks), '')
  assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'), true)
  assert.equal(chunks.at(-1).reason.kind, 'tool-call')
})

test('a plain tool-call stream is untouched', async () => {
  const input = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-call' } },
  ]
  assert.deepEqual(await collect(input), input)
})

test('a stream that ends mid-block never swallows content', async () => {
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial answer' },
  ]
  const chunks = await collect(input)
  assert.equal(textOf(chunks), 'partial answer')
})
