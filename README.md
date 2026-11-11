# dsh-dsml-leak-guard

> 网关把 DeepSeek 工具调用解析失败时，会把 DSML 控制标签当成普通文本吐出来。宿主以为模型正常结束，于是这一轮静默停住，脏消息还会留在历史里。这个插件把这类文本块丢掉，并让这一轮变成可重试的空响应。

## 问题长什么样

一些 OpenAI 兼容网关（第三方中转、企业网关等）在把 DeepSeek 的 tool call 翻译成 Anthropic `tool_use` 时失败，会把原始控制语法当成正文发出来：

```text
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

对 DSH 来说这是一条普通的 `stop`：本轮被判定为「已完成」，助手消息只有一串乱码标签。这条消息落盘后，后续每次请求都会把它带回给模型，模型于是继续模仿这种输出。

## 它做什么

在 `llm/stream` 上包一层流：

1. 文本块先扣住，按开头几个字符判断是正常正文还是泄漏的 DSML；
2. 判断为泄漏、且整块只有 DSML 标签和空白 → **整块丢弃**（`block-start`、增量、`block-end` 一起丢，不留空块）；
3. 如果整轮因此什么都没产出，把结尾的 `finish` 改写成 `EMPTY_RESPONSE` 失败；
4. `@deepseek-ai/dsh-llm-retry` 默认就把 `EMPTY_RESPONSE` 当可重试错误，于是自动重发请求（默认 5 次，500 ms 起，指数退避）。

重试是一次全新的请求：没有脏消息进历史，也不会插入「继续」之类的合成消息。五次都失败时这一轮以可见错误结束，而不是静默停止。

识别 DSML 标签的常见写法：`｜｜DSML｜｜`（实测主流）、`｜DSML｜`、`||DSML||`，单个 `|` 也兼容。

## 边界

**只管「整轮只有标签」这一种泄漏。** 正文里夹带标签（例如答案完整、末尾跟一串闭合标签）会原样放行——插件在开头就判定为正常文本，不会为了清尾部而缓存整段输出。

这条边界是有意的：扣住整段正文会推迟首字，也会让流式体验变差；空轮才是真正弄脏历史、让会话「卡死」的那一种。

## 安装

### 插件市场 / npm

```sh
dsh plugin --profile web add dsh-dsml-leak-guard
```

装完重启 `dsh web`（Desktop 版在「设置 → 插件」里装，重启应用）。

### 直接从 GitHub 装

```sh
dsh plugin --profile web add github:<你>/dsh-dsml-leak-guard
```

### 本地开发时手工挂载

在 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-dsml-leak-guard
      name: "file:///绝对路径/dsh-dsml-leak-guard/lib/index.js"
```

路径里的空格要写成 `%20`。改完重启宿主。

> 如果你之前用别的 id 手工挂过一个同类守卫，先删掉那行，避免同一条流被包两次。

## 配置

没有配置项。判定规则写死在 `lib/index.js` 顶部的 `SEPS` / `MARKER_PREFIXES` / `DSML_ONLY` 里，改完跑一遍测试即可。

## 开发

```sh
npm test        # node --test，覆盖分类、丢弃、拆分增量、工具调用共存、流中断
npm run check   # 语法检查
```

插件本身零依赖；`lib/index.js` 同时导出 `classify()` 和 `guardStream()`，方便单测直接打流。

## 已知的同类项目

- [Jessicaisleep/dsh-dsml-guard](https://github.com/Jessicaisleep/dsh-dsml-guard)：清洗正文里的标记，空轮时补一条「继续」，并区分可重试/不可重试错误。
- [GooDAnDReaDY/dsh-dsml-artifact-guard](https://github.com/GooDAnDReaDY/dsh-dsml-artifact-guard)：流式清洗 DSML / 推理残渣，覆盖更广。
- [liufeicc/dsh-dsml-guard](https://github.com/liufeicc/dsh-dsml-guard)：处理推理通道里泄漏成文本的工具调用。

本项目的差异点是**窄**：不解析标签内部结构、不改写正文，只做「整块丢弃 + 触发宿主自带重试」，因此代码量小、没有正则状态机，也不会改动正常输出。

## License

MIT
