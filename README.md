# dsh-dsml-leak-guard

中文 | [English](README.en.md)

DSH 插件。有些网关解析不了 DeepSeek 的工具调用，会把 DSML 控制标签当普通文本吐出来。宿主收到的是一个正常的停止信号，这一轮就这么静默结束了，而这条只有标签的消息还会写进会话历史。插件把这类纯标签的文本块丢掉，再把这一轮变成可重试的空响应。

## 现象

一些 OpenAI 兼容网关（第三方中转、企业网关之类）在转发 DeepSeek 的工具调用时解析失败，会把内部的控制语法当正文发出来：

```text
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
```

对 DSH 来说，这就是一次普通的 `stop`：这一轮算正常完成，助手消息里只有这串标签。它一旦写进历史，后面每次请求都会带上它，模型也跟着模仿这种输出，泄漏就一路延续下去。

## 处理方式

插件包在 `llm/stream` 外面，做四件事：

1. 文本块先扣住，看开头几个字符，判断是正常正文还是泄漏的 DSML；
2. 如果整块只有 DSML 标签和空白，就整块丢弃，`block-start`、增量、`block-end` 都不往外发；
3. 如果整轮因为这个没有任何可见内容，就把结尾的 `finish` 改写成 `EMPTY_RESPONSE`；
4. `@deepseek-ai/dsh-llm-retry` 默认把 `EMPTY_RESPONSE` 当可重试错误，于是自动重发请求（默认重试 5 次，间隔从 500 ms 起，指数退避）。

重试是一次干净的新请求：没有脏消息进历史，也不会插一条「继续」之类的合成消息。五次都失败时，这一轮以看得见的错误结束，而不是又静默停住。

标签写法按实测兼容这几种：`｜｜DSML｜｜`（全角双竖线，最常见）、`｜DSML｜`、`||DSML||`、`|DSML|`。

## 边界

只处理「整轮只有标签」这一种。正文里夹带标签的（比如答案本身完整、末尾跟一串闭合标签）原样放行。

这么定是因为：要把正文里的标签也清掉，就得把整段输出缓存下来，首字会明显变慢，流式体验也就没了。真正弄脏历史、让会话卡住的是空轮，先把这一类解决掉。

## 安装

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:GoGoZeppeli-towa/dsh-dsml-leak-guard
```

### 从 npm 安装

（包发布上架后可用）

```sh
dsh plugin --profile web add dsh-dsml-leak-guard
```

装完重启 `dsh web`。Desktop 版在「设置 → 插件」里安装，装完重启应用。

### 本地开发时手工挂载

在 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-dsml-leak-guard
      name: "file:///绝对路径/dsh-dsml-leak-guard/lib/index.js"
```

路径里的空格要写成 `%20`。改完重启宿主。

如果之前用别的 id 手工挂过类似的守卫，先把那行删掉，不然同一条流会被包两层。

## 配置

没有配置项。判定规则在 `lib/index.js` 顶部的 `SEPS`、`MARKER_PREFIXES`、`DSML_ONLY` 里，改完跑一遍测试就行。

## 开发

```sh
npm test        # node --test，覆盖分类、丢弃、增量被拆开、与工具调用共存、流中途结束
npm run check   # 语法检查
```

插件零依赖。`lib/index.js` 另外导出 `classify()` 和 `guardStream()`，单测可以直接对着流打。

## 同类项目

- [Jessicaisleep/dsh-dsml-guard](https://github.com/Jessicaisleep/dsh-dsml-guard)：清洗正文里的标记，空轮时补一条「继续」，并区分可重试与不可重试的错误。
- [GooDAnDReaDY/dsh-dsml-artifact-guard](https://github.com/GooDAnDReaDY/dsh-dsml-artifact-guard)：流式清洗 DSML 和推理残渣，覆盖面更广。
- [liufeicc/dsh-dsml-guard](https://github.com/liufeicc/dsh-dsml-guard)：处理推理通道里泄漏成文本的工具调用。

这个项目的做法是窄：不解析标签内部结构，不改写正文，只做「整块丢弃 + 交给宿主自带的重试」。代码量小，没有正则状态机，正常输出不受影响。

## License

MIT
