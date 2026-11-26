# inquiry-ladder · 层层追问

> 对一篇论文、一份报告或任意长文做分层追问：每层问题由上一层答案的弱点触发，每问必答、答后必驳、驳后再追。
> Layered Socratic inquiry for DeepSeek Harness: each question is triggered by a weakness in the previous answer.

**中文** · [English](README.en.md)

不是摘要工具。它把材料变成一串有依赖关系的质疑，逼出答案的边界，最后落成一份带原文锚点的追问报告。

---

## 它和「让模型自己追问」有什么不同

三个角色由插件在 Host 内部分别调用，会话里只留每层约 400 token 的摘要：

- **提问者** — 只问本层的主问题，必须用「」逐字引用原文并标 quote id，且必须由上一层答案里的某处薄弱点触发；
- **应答者** — 作答，每条结论用 `[E1 q3]` 这种「证据等级 + 锚点」标注（E1 原文实测 / E2 原文推理 / E3 领域常识未核 / E4 推测），答不出的写进「答不出」；
- **审辨者** — 找没有证据支撑的地方，并**至少给出一个替代解释或反例场景**。给不出，这一层就不许推进。

这些规则写在代码里，不靠模型自觉：没锚点的问题重生成一次，与旧问题高度重复会标出来，同分支相邻两层算子不许相同。

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

默认只走到 L4（`maxDepth: 5`）。这一层问完，下一层的算子由审辨者的建议和阶梯共同决定。

## 工具

| 工具 | 作用 | 成本 |
|---|---|---|
| `inquiry_open` | 抽出可被追问的证据骨架（主张、证据、隐含前提、逐字锚点），给出 L0 与三个入口 | 1–2 次调用 |
| `inquiry_probe` | 推进一层；`auto: true` 连续推进到收敛或预算用尽 | 3 次调用/层 |
| `inquiry_view` | 看问题树或某一层全文 | 0 |
| `inquiry_report` | 生成 Markdown 报告到工作区 | 1 次调用 |

所有调用转发取消信号；中途停止不会留下半条记录。追问记录存在 `~/.dsh/inquiry/<id>/`，可断点续跑。

## 安装

```bash
dsh plugin --profile <profile> add <指向本目录的绝对路径>
```

或在应用里：**Plugins** → **Add plugin** → 选本目录。本地目录安装是 link 方式，改完代码在插件页关一下再开就会重新加载。

## 用法

```
inquiry_open(path: "paper.md", focus: "它的评测协议是否公平")
inquiry_probe(inquiry_id: "inq_...", operator: "evidence")
inquiry_probe(inquiry_id: "inq_...", auto: true)
inquiry_report(inquiry_id: "inq_...")
```

PDF 不要直接喂：先用 paper-miner 的 `paper_brief` 把论文压成论证骨架，再把文本作为 `text` 传入。这样既省 token，也保证追问引用的是原文句子而不是解析噪音。

## 配置

在 `cordis.patch.yml` 里覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxDepth` | 5 | 1–7 |
| `maxCalls` | 20 | 单次追问的模型调用上限 |
| `maxTokens` | 150000 | 单次追问的 token 预算 |
| `autoMax` | 3 | `auto: true` 单次最多连推几层 |
| `roles.questioner` / `answerer` / `critic` | 继承会话模型 | 可分别给 `{provider, model}`，例如追问用强模型、应答用快模型 |
| `lang` | `zh` | 报告语言；`en` / `auto` |
| `strictAnchors` | `true` | 无锚点的问题重生成 |
| `maxSourceChars` | 48000 | 单次送入的源文本上限，超出会明确标注截断 |
| `reportDir` | `inquiry` | 报告目录（相对工作区） |

## 成本

实测（`opencode-go / deepseek-v4.1-flash`）单层约 1.2–1.5 万 token，五层加报告约 8 万、3–6 分钟。推理模型的思考也计入输出，所以预算给得比较宽；对成本敏感时把 `depth` 调到 3，三层足以看出材料成色。

## 已知限制

- 不解析 PDF，需要先走 `paper-miner`。
- 长文截断到 `maxSourceChars`，报告里会写明截断事实。
- 追问记录在 `~/.dsh/inquiry/<id>/`，换机器或清缓存后无法续跑，需重新 `inquiry_open`。
- `url` 依赖 profile 里的 web 服务。
- 报告质量取决于所选模型的结构化输出能力；某个角色的 JSON 连续两次解析失败会报 `BAD_JSON`，此时给该角色换模型（在 `roles` 里配）。输出被 `maxTokens` 截断时插件会自动以 4 倍预算重试一次。

更细的机制、报告结构与验证方法见 [docs/DETAIL.md](docs/DETAIL.md)。
