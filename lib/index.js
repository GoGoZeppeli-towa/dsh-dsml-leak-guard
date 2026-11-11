/**
 * dsh-dsml-leak-guard
 *
 * Some OpenAI-compatible gateways fail to translate a DeepSeek tool call into
 * an Anthropic `tool_use` block and instead leak the raw DSML control syntax
 * as a plain text block:
 *
 *     </｜｜DSML｜｜ invoke>
 *     </｜｜DSML｜｜ calls>
 *
 * The harness sees a normal `stop`, so the turn silently ends with an
 * assistant message that contains nothing but garbled control tags. That
 * message is persisted, fed back on every later request, and teaches the model
 * to repeat it.
 *
 * This plugin wraps the `llm/stream` waterfall:
 *
 *   1. a text block is held back until its opening characters prove it is
 *      either real prose or leaked DSML;
 *   2. a block made only of DSML tags is dropped entirely (no `block-start`,
 *      no `block-end`, no deltas — the assembler is index-based and does not
 *      require contiguous indices);
 *   3. if the whole response ends up empty because of that, the terminal
 *      `finish` is rewritten into an `EMPTY_RESPONSE` failure, which
 *      `@deepseek-ai/dsh-llm-retry` retries by default (5 attempts, 500 ms
 *      initial delay, exponential backoff with jitter).
 *
 * A retried attempt is a fresh request: nothing dirty is committed to the
 * session history, and no synthetic "continue" message is inserted. If every
 * attempt hits the same gateway bug the turn ends with a visible error instead
 * of a silent stop.
 *
 * Scope: this plugin handles the *empty* leak (the turn produced nothing but
 * tags). A block that carries real prose and DSML tags together is passed
 * through unchanged.
 */

export const name = 'dsh-dsml-leak-guard'

export const inject = []

const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Separators observed in the wild. Double-bar is what the reference gateway
 * emits; the single-bar and ASCII forms are the same protocol, serialized
 * differently by other proxies.
 */
const SEPS = ['｜｜', '||', '｜', '|']

/** Opening fragments that can only come from leaked DeepSeek control syntax. */
const MARKER_PREFIXES = SEPS.flatMap((sep) => [`</${sep}DSML${sep}`, `<${sep}DSML${sep}`])

const DSML_SEP = '(?:｜｜|\\|\\||｜|\\|)'

/** A text block whose entire content is one or more DSML tags and whitespace. */
const DSML_ONLY = new RegExp(`^(?:\\s*<\\/?${DSML_SEP}DSML${DSML_SEP}[^>]*>)+\\s*$`)

const DROP_MESSAGE =
  '模型只输出了 DSML 工具调用标签（网关把工具调用解析失败），本轮没有产生有效内容。'

/**
 * 0 = still undecided, 1 = pass the block through, 2 = buffer for DSML check.
 */
export function classify(text) {
  const trimmed = text.replace(/^\s+/, '')
  if (trimmed === '') return 0
  for (const marker of MARKER_PREFIXES) {
    if (trimmed.startsWith(marker)) return 2
  }
  // The delta may have split inside the marker itself, e.g. "<" then "</｜".
  for (const marker of MARKER_PREFIXES) {
    if (marker.startsWith(trimmed)) return 0
  }
  return 1
}

function textOf(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/**
 * Wrap one raw harness LLM chunk stream.
 *
 * @param {AsyncIterable<any>} source
 * @param {(message: string) => void} [warn]
 */
export async function* guardStream(source, warn) {
  /** Chunks of the text block currently being decided. */
  let held = null
  /** True once the held block is known to start like leaked DSML. */
  let schedulingDrop = false
  let droppedAny = false
  let sawVisible = false

  const flushHeld = function* () {
    if (held === null) return
    for (const chunk of held) yield chunk
    held = null
    schedulingDrop = false
  }

  for await (const chunk of source) {
    if (chunk === null || typeof chunk !== 'object') {
      yield chunk
      continue
    }

    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      held = [chunk]
      schedulingDrop = false
      continue
    }

    if (held !== null) {
      if (chunk.type === 'text-delta') {
        held.push(chunk)
        if (!schedulingDrop) {
          const decision = classify(textOf(held))
          if (decision === 1) {
            sawVisible = true
            yield* flushHeld()
          } else if (decision === 2) {
            schedulingDrop = true
          }
        }
        continue
      }

      if (chunk.type === 'block-end') {
        const text = textOf(held)
        if (schedulingDrop) {
          if (DSML_ONLY.test(text)) {
            droppedAny = true
            if (typeof warn === 'function') warn('dropped a text block made only of DSML tags')
            held = null
            schedulingDrop = false
            continue
          }
          if (typeof warn === 'function') {
            warn('held text block looked like DSML but carried other text; passing it through')
          }
        }
        if (text.trim() !== '') sawVisible = true
        yield* flushHeld()
        yield chunk
        continue
      }

      // Any other chunk cannot belong to a text block; let the block through.
      if (textOf(held).trim() !== '') sawVisible = true
      yield* flushHeld()
      // fall through to the normal handling of this chunk
    }

    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
      sawVisible = true
    }
    if (chunk.type === 'text-delta') {
      sawVisible = true
    }

    if (chunk.type === 'finish' && droppedAny && !sawVisible && chunk.reason?.kind === 'stop') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: DROP_MESSAGE, code: EMPTY_RESPONSE_CODE },
        },
      }
      continue
    }

    yield chunk
  }

  // The stream ended while a text block was still held (should not happen,
  // but never swallow content silently).
  if (held !== null) {
    const text = textOf(held)
    if (schedulingDrop && DSML_ONLY.test(text)) {
      droppedAny = true
    } else {
      yield* flushHeld()
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let logger
  try {
    logger = ctx.logger ? ctx.logger('dsh-dsml-leak-guard') : undefined
  } catch {
    logger = undefined
  }
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      /* logging must never break a request */
    }
  }

  try {
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      if (stream === null || typeof stream !== 'object' || typeof stream[Symbol.asyncIterator] !== 'function') {
        return stream
      }
      return guardStream(stream, warn)
    })
  } catch (error) {
    warn(`could not register llm/stream guard: ${error instanceof Error ? error.message : String(error)}`)
  }
}
