# inquiry-ladder · 层层追问

> 对一篇论文、一份报告或任意文档做分层追问：每层问题由上一层答案的弱点触发，每问必答、答后必驳、驳后再追；最后从材料里挖出可以动手的科研问题。
> Layered Socratic inquiry for DeepSeek Harness: each question is triggered by a weakness in the previous answer.

**中文** · [English](README.en.md)

不是摘要工具。它把材料变成一串有依赖关系的质疑，逼出答案的边界，再把「所以我能做什么」写清楚。

---

## 它和「让模型自己追问」有什么不同

三个角色由插件在 Host 内部分别调用，会话里只留每层约 400 token 的摘要：

- **提问者** — 只问本层的主问题，必须用「」逐字引用原文并标 quote id，且必须由上一层答案里的某处薄弱点触发；
- **应答者** — 作答，每条结论用 `[E1 q3]` 这种「证据等级 + 锚点」标注（E1 原文实测 / E2 原文推理 / E3 领域常识未核 / E4 推测），答不出的写进「答不出」；
- **审辨者** — 找没有证据支撑的地方，并**至少给出一个替代解释或反例场景**。给不出，这一层就不许推进。

这些规则写在代码里，不靠模型自觉：没锚点的问题重生成一次，与旧问题高度重复会标出来，同分支相邻两层算子不许相同。

## 输入格式

文件直接给路径，按扩展名自动抽取正文：

| 格式 | 说明 |
|---|---|
| `.md` `.txt` `.rst` `.csv` `.json` `.yaml` `.tex` `.bib` 等 | 直接读纯文本 |
| `.html` | 去标签，保留段落边界 |
| `.docx` | 内置 ZIP + OOXML 解析，保留标题层级 |
| `.pptx` | 内置解析，按幻灯片序号 |
| `.epub` | 内置解析，按章节拼接 |
| `.pdf` | 用本机 `pdftotext`，否则 `python + pypdf` |
| `url` | 走 profile 的 web 服务 |

PDF 不内置解析器——真正的 PDF 解析要处理字体、CMap、xref，做不完整比不做更糟。两条外部路径都找不到时会明确告诉你三条出路，而不是静默返回空文本；扫描件也会被识别为「没有文字层」。

## 八级阶梯

| 层 | 算子 | 问什么 |
|---|---|---|
| L0 | 定位 Orient | 它在跟谁竞争，作者承诺了什么 |
| L1 | 拆解 Decompose | 论证由哪几条断言撑起来，哪条是支柱 |
| L2 | 前提 Premise | 结论默认了什么没说出口的东西 |
| L3 | 证据 Evidence | 基线公平吗，指标测的是它声称的东西吗 |
| L4 | 边界 Boundary | 构造一个让它失效的场景 |
| L5 | 替代 Rival | 还有什么机制能产生同样现象，怎么区分 |
| L6 | 预测 Predict | 若为真，应观察到什么还没人观察到的现象 |
| L7 | 迁移 Transfer | 抽出的机制能搬到哪，换掉核心假设会怎样 |

默认只走到 L4（`maxDepth: 5`）。下一层的算子由审辨者的建议和阶梯共同决定。

## 科研问题

追问到一定深度后，`inquiry_problems` 会把材料里藏着的科研问题挖出来。每个问题必须同时满足五条：有原文锚点、不空泛、落到可观测的量、说清与作者的关系（已提及缺什么 / 未提及为什么被忽略）、有一个一周内能开始的最小实验。

分六类：**机制未解释**、**部署假设不成立**、**评测盲区**、**数据缺口**、**可迁移未做**、**前提脆弱**。按「可做性 × 影响」排序，第一条最值得马上做。`inquiry_report` 在没挖过问题时会自动补一轮，所以报告不会只批评不给出口。

## 工具

| 工具 | 作用 | 成本 |
|---|---|---|
| `inquiry_open` | 抽正文，生成证据骨架（主张、证据、隐含前提、作者自述局限与后续工作、逐字锚点） | 1–2 次调用 |
| `inquiry_probe` | 推进一层；`auto: true` 连续推进到收敛或预算用尽 | 3 次调用/层 |
| `inquiry_problems` | 挖 1–6 条科研问题 | 1 次调用 |
| `inquiry_view` | 看问题树或某一层全文 | 0 |
| `inquiry_report` | 生成含科研问题章的 Markdown 报告 | 1–2 次调用 |

所有调用转发取消信号；中途停止不会留下半条记录。追问记录存在 `~/.dsh/inquiry/<id>/`，可断点续跑。

## 安装

```bash
dsh plugin --profile <profile> add <指向本目录的绝对路径>
```

或在应用里：**Plugins** → **Add plugin** → 选本目录。本地目录安装是 link 方式，改完代码在插件页关一下再开就会重新加载。

## 用法

```
inquiry_open(path: "论文.docx", focus: "它的评测协议是否公平")
inquiry_probe(inquiry_id: "inq_...", operator: "evidence")
inquiry_problems(inquiry_id: "inq_...", focus: "真实部署")
inquiry_report(inquiry_id: "inq_...")
```

## 配置

在 `cordis.patch.yml` 里覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxDepth` | 5 | 1–7 |
| `maxCalls` | 20 | 单次追问的模型调用上限 |
| `maxTokens` | 150000 | 单次追问的 token 预算 |
| `autoMax` | 3 | `auto: true` 单次最多连推几层 |
| `roles.questioner` / `answerer` / `critic` | 继承会话模型 | 可分别给 `{provider, model}`，例如追问用强模型、应答用快模型 |
| `pdfTool` | 空 | `pdftotext` 的绝对路径，覆盖自动探测 |
| `pythonPath` | 空 | 装了 `pypdf` 的解释器绝对路径 |
| `lang` | `zh` | 报告语言；`en` / `auto` |
| `strictAnchors` | `true` | 无锚点的问题重生成 |
| `maxSourceChars` | 48000 | 单次送入的源文本上限，超出会明确标注截断 |
| `reportDir` | `inquiry` | 报告目录（相对工作区） |

## 成本

实测（`opencode-go / deepseek-v4.1-flash`）单层约 1.2–1.5 万 token；一层追问 + 一轮科研问题 + 报告约 3–4 万。推理模型的思考也计入输出，所以预算给得比较宽；对成本敏感时把 `depth` 调到 3，三层足以看出材料成色。

## 已知限制

- PDF 依赖外部提取器；没有 `pdftotext` / `pypdf` 时返回 `PDF_NO_BACKEND`，并给出三条替代路径。
- 扫描件、纯图片 PDF 需要先 OCR。
- 长文截断到 `maxSourceChars`，报告里会写明截断事实。
- 追问记录在 `~/.dsh/inquiry/<id>/`，换机器或清缓存后无法续跑。
- 报告质量取决于所选模型的结构化输出能力；某个角色的 JSON 连续两次解析失败会报 `BAD_JSON`，此时给该角色换模型（在 `roles` 里配）。输出被 `maxTokens` 截断时会自动以 4 倍预算重试一次。

更细的机制、报告结构与验证方法见 [docs/DETAIL.md](docs/DETAIL.md)。
