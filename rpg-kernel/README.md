# 枢引擎 Pivot Engine v0.1

一个**框架无关**的硬核文本 RPG 内核。它自己不含任何世界观、不含任何 AI 厂商代码、不含任何规则。
规则在 `rulepacks/`，叙事能力在 `adapters/`，两者都能换掉而不动内核。

一句话：**你把它当"裁判主席"，具体谁来判，由你挂哪个框架决定。**

---

## 一、为什么这么设计

你的规则里反复出现的失败模式，本质是「把规则、叙事、状态、审查全压在同一个黑箱里」。
黑箱内部没法被你检查、没法被你替换、出了问题只能整箱重来。

枢引擎的切法：

| 层 | 职责 | 能不能被你替换 |
|---|---|---|
| `core/` 内核 | 状态、回合、时间锁、线索表、档案卡 | 一般不动 |
| `adapters/` 适配器 | **调用外部框架** | 随时换，随时加 |
| `rulepacks/*.json` 规则包 | 世界观与硬规则 | 换一个 JSON 就是换一个游戏 |
| `rulepacks/states/*.json` 起始局面 | 存档种子 | 随便加 |
| `public/` 控制台 | 界面 | 可以换别的壳 |

---

## 二、「调用其他框架」的统一合约

引擎只认这一个函数签名，除此之外什么都不知道：

```js
call({ system, prompt, temperature, maxTokens }, config)
  -> { text, raw, meta }
```

任何东西只要能被包成这个形状，就能挂进来。当前内置：

| 适配器 id | 调用什么 | 备注 |
|---|---|---|
| `skeleton` | 什么都不调 | 离线骨架，验证管线用，不生成叙事 |
| `deepseek` | api.deepseek.com | **默认**。chat 写正文，reasoner 当核查，R1 自动不传 temperature |
| `openai-compatible` | `/chat/completions` | 覆盖 OpenAI、DeepSeek、通义、Moonshot、vLLM、LM Studio、Ollama 兼容层 |
| `ollama` | 本机 Ollama `/api/chat` | 完全离线 |
| `anthropic` | 原生 `/v1/messages` | system 走顶层字段 |
| `http-json` | 任意 HTTP JSON 服务 | **接自研框架最省事的一条路** |
| `python-subprocess` | spawn 进程，stdin 写 JSON | 任何语言写的程序都能挂（换 `java`/`node` 同理） |
| `mcp-stdio` | MCP server 的 tool | 实验实现，各 server 入参不一 |

### 免改代码接入一个新框架

在 `data/adapters/` 丢一个 manifest，重启后控制台自动出现：

```json
{
  "id": "my-langserve",
  "displayName": "我的 LangServe 服务",
  "kind": "http-json",
  "config": { "url": "http://127.0.0.1:8000/gm/invoke" }
}
```

`kind` 决定用哪个内置协议去打车，写框架的人只需要在对端提供一端 HTTP 收 `{system, prompt}`、回 `{text}`。

---

## 三、这条管线怎么落实你的规则

### 1. 时空锁定（方案D）
`runTurn` **只产出草稿，绝不写时间线**。
只有你点「采纳」走 `applyDraft`，`clock / turn / npcs / threads` 才会改。
默认推进天数是 0 —— 引擎里没有任何机制会替你跳时间，天数是你自己填的。

### 2. 决定权归你（方案E）
提示词里明确要求结尾输出「用户决定」标记；审查器会检查这个标记是否存在。
**更关键的是：你不勾选要触及的线索，框架就被明令禁止替你推进或收尾任何线索**（见提示词里那段条件分支）。
线索的三种状态（追查 / 了结 / 搁置）只有左栏那三个链接能改，GM 输出碰不到。

### 3. 诚实的审查（方案B）
`core/audit.js` 输出三态：**通过 / 存疑 / 信息缺口**。
最后一栏固定是「引擎无法验证的部分」——史实正误、语域、推理断层，这些它没有知识源，
永远打「信息缺口」，**永远不会替你打勾**。避免回到你之前踩过的"打✓但没真检查"。

实测能力边界（我自己跑过的）：
- 能抓：禁用词表、模糊指代（「那位官员」「三个月之后」这类）、缺「用户决定」标记、NPC 缺字段、引用了不存在的线索、字数不足。
- 抓不到：史实参错、隐性未卜先知、对话语域不合身份、逐句缓慢推进式的软性跳时间。**这些只能靠人，或挂带检索的框架进来。**

### 4. NPC 自主性（方案C）
存档里每个 NPC 强制三件：`goal / risk / defectionCondition`。
缺了任一件，左栏会显式标红，并且提示词会自动加一句"此人在档案里没有写明，出场前你必须先补写这三项"。

### 4b. 事实核查：真正去查，而不是自称查过
`adapters/search.js` + `core/verify.js` 把「虚构 NPC 是否与真实历史人物重名」这件事真正做了检索核验。
支持 7 个后端（Wikipedia / Wikidata / SearXNG 免费无需 key；Tavily / Serper / Bing / 博查 需 key），
证据带原始链接、附相关性过滤，结论只用三态表述。
详细的配置步骤、拿 key 的途径、成本估算见 **[运行与检索指南.md](./运行与检索指南.md)**。

### 开一个别的朝代

右上「＋ 新开局」：内置 **16 个朝代预设**（秦 → 清），也可以自己填年号和公元年；
身份从皇帝 / 宗室 / 官员 / 军阀 / 百姓五种视角里挑（各自注入不同的权力与信息约束）；
地点、姓名、年龄、头衔、开局处境、开局线索都能自己填。**全部可留空 —— 留空的由 GM 按该朝代真实情况补。**
「档案卡」按钮生成简明状态卡，粘到任意新对话里即可续档，不需要 AI 假装跨对话记忆。

---

## 四、跑起来（Windows 双击即可）

双击 **`一键启动.bat`**。它会自己找 Node（PATH → WorkBuddy 托管版 → Program Files → nvm）、起服务、3 秒后自动开浏览器；窗口保持显示日志，关窗口或 Ctrl+C 即停。

```bash
# 其他系统 / 换端口
node server.js
PORT=8899 node server.js
```

零依赖，Node 22+。填过的 Key 存在 `data/adapter-config.json`，重启、换浏览器都不会丢。

默认已经预置并选中 **DeepSeek**（`deepseek-chat`）：控制台「框架配置」里贴上 Key →「连通测试」看到 OK 即可。
想用推理更强的 `deepseek-reasoner` 当第二个核查裁判也支持 —— R1 不吃 `temperature`，引擎按模型名自动跳过。

完整配置步骤、检索后端对比、常见问题见 **[运行与检索指南.md](./运行与检索指南.md)**。

不配任何 Key 也能玩：选 `skeleton`，整套管线会跑通但不产生叙事——这是用来验证管道和审查器的。

---

## 五、下一步最值得做的三件事

1. ~~**检索适配器**~~ **已实现**：`adapters/search.js` 接入了 Wikipedia / Wikidata / SearXNG / Tavily / Serper / Bing / 博查 七个后端，`core/verify.js` 把它变成了可执行的 NPC 五步重名核验与地点/人物/措辞核查。剩下的深水区是：**如何让核查结论也参与叙事生成前的拦截**（目前是给你看，不自动否决），以及给它挂上一层 CBDB/正史全文检索，覆盖只有地方志才记一笔的下层人物。
2. **双裁判**：生成用一个便宜/快的框架，核查用另一个强框架——把 `python-subprocess` 或 `http-json` 再注册一份就行，这正是这套适配器设计的目的。核查结果与你自己的判断并排对照，而不是合并成一个看不出来源的结论。
3. **历法 adapters**：现在是 30 天进位的糙实现，跨年会把年号标成「需人工校正」。要做严谨就单独挂一个历法服务。

---

## 六、已知的坑

- 时间进位是 30 天一月，不做真实朔闰。跨年会把 `yearLabel` 打上「需人工校正」标记而不是偷偷改年号。
- `extractJson` 取文中第一个完整 JSON 对象；模型在 JSON 后面追加正文时以 JSON 为准，纯文本无 JSON 时整个 `scene` 就是正文并标 `parseFailed`。
- MCP 适配器是实测实现，`tools/call` 的入参名在不同 server 上不一致，大概率要按具体 server 改。
- 存档是纯 JSON 文件，直接手改也能改，但别同时开两个编辑窗口。

---

## 文件地图

```
server.js               零依赖 HTTP 服务
core/engine.js          存档、回合、apply/apply separated、档案卡
core/prompt.js          提示词组装（规则全来自包）
core/audit.js           三态审查器
adapters/index.js       注册表 + 七种内置调用方式（叙事）
adapters/search.js      检索后端注册表 + 缓存 + 限流重试（事实核查）
core/verify.js          四层核查流水线 / NPC 五步验证
rulepacks/history-sim-v4.json      你那套 v3.3+v4.0 规则的机器可读版
rulepacks/states/*.json            起始局面
public/                 控制台
data/saves/             存档
data/adapters/          外部框架 manifest（免改代码接入）
```

## 本轮改进（朝政案牍 / 模型与维基护栏）

- **案牍（仿《崇祯模拟器》）**：每回合引擎按存档里的真实钱粮、粮价、灾情、军心、民心送来 1~3 件奏报/公文，
  每个选项的后果（钱、粮、税率、兵、民心、吏治、威望、匪患）先看后批，批完立即入账；不配 AI 也能玩。
  四项朝局指标会自行演化：吏治决定钱赋实收几成，民心低则匪患起，灾荒致流亡。批阅结果会写进给 GM 的提示，由 AI 叙其后果。
- **DeepSeek 护栏**（`adapters/guard.js`）：Key 失效/欠费熔断 10 分钟（不再每次卡满超时），限流与网络抖动退避重试，
  同时最多 2 个请求，要求 JSON 的调用开 JSON 模式并自动修复，抽取类结果短期缓存。用量与熔断状态见 `/api/health`。
- **Wikidata 护栏**：查询串行且间隔 1.2 秒，429/5xx 按 Retry-After 退避，连续失败 3 次暂停 5 分钟、改用本地人物库，成功结果永久缓存。
- 修正：灾情现在真的影响收成与粮价（原先永远是「无」）；新增钱赋实收与军饷，钱不再只出不进。
