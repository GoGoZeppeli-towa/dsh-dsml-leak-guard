# dsh-dsml-leak-guard

[中文](README.md) | English

A DSH plugin. Some gateways fail to parse DeepSeek tool calls and send the raw DSML control tags out as plain text. To the harness it looks like a normal stop: the turn ends silently, and the tag-only message gets saved into the session history. The plugin drops those blocks and turns the now-empty turn into a retryable error.

## What it looks like

Some OpenAI-compatible gateways (third-party relays, corporate proxies) fail to translate a DeepSeek tool call and leak the raw control syntax as message text:

```text
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

DSH reads that as an ordinary `stop`: the turn counts as completed, and the assistant message holds nothing but tags. Once that message is in the history, every later request carries it, the model picks up the pattern, and the leak keeps going.

## What it does

The plugin wraps `llm/stream` and does four things:

1. hold a text block back until its first few characters show whether it is prose or leaked DSML;
2. if the whole block is only DSML tags and whitespace, drop it — no `block-start`, no deltas, no `block-end`;
3. if that leaves the turn with nothing visible, rewrite the trailing `finish` into `EMPTY_RESPONSE`;
4. `@deepseek-ai/dsh-llm-retry` already treats `EMPTY_RESPONSE` as retryable, so the request is sent again (5 retries by default, starting at 500 ms, exponential backoff).

Each retry is a clean request: no dirty message reaches the history, and nothing like a synthetic "continue" is inserted. If every attempt fails, the turn ends with a visible error instead of stopping silently.

Separator variants seen so far, all supported here: `｜｜DSML｜｜` (full-width double bar, the common one), `｜DSML｜`, `||DSML||`, `|DSML|`.

## Scope

Only the empty case is handled: a turn that produced nothing but tags. A block that mixes real prose with tags (a complete answer followed by closing tags, for instance) passes through unchanged.

That is deliberate. Stripping tags out of prose means buffering the whole message, which delays the first token and ruins streaming. The empty turn is what actually pollutes the history and jams the session, so that is the case worth fixing first.

## Install

### From GitHub

```sh
dsh plugin --profile web add github:GoGoZeppeli-towa/dsh-dsml-leak-guard
```

### From npm

```sh
dsh plugin --profile web add dsh-dsml-leak-guard
```

Restart `dsh web` afterwards. In the desktop app, install it under Settings → Plugins and then restart the app.

### Manual mount for local development

Append this to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-dsml-leak-guard
      name: "file:///absolute/path/to/dsh-dsml-leak-guard/lib/index.js"
```

Spaces in the path must be written as `%20`. Restart the host afterwards.

If a similar guard is already mounted under a different id, remove that line first — otherwise the same stream gets wrapped twice.

## Config

None. The rules live in `SEPS`, `MARKER_PREFIXES` and `DSML_ONLY` at the top of `lib/index.js`; run the tests after changing them.

## Development

```sh
npm test        # node --test: classification, dropping, split deltas, coexisting tool calls, stream ending mid-block
npm run check   # syntax check
```

No dependencies. `lib/index.js` also exports `classify()` and `guardStream()` so tests can drive the stream directly.

## Related projects

- [Jessicaisleep/dsh-dsml-guard](https://github.com/Jessicaisleep/dsh-dsml-guard) — strips markers from prose, appends a "continue" for empty turns, and separates retryable from non-retryable errors.
- [GooDAnDReaDY/dsh-dsml-artifact-guard](https://github.com/GooDAnDReaDY/dsh-dsml-artifact-guard) — streaming cleanup of DSML and reasoning leftovers, broader in scope.
- [liufeicc/dsh-dsml-guard](https://github.com/liufeicc/dsh-dsml-guard) — handles tool calls that leak as text into the reasoning channel.

This one stays narrow on purpose: it does not parse tag internals or rewrite prose, it only drops tag-only blocks and hands the turn to the retry logic the host already has. Small codebase, no regex state machine, normal output untouched.

## License

MIT
