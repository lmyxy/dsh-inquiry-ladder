# 追问引擎 Inquiry Ladder · 设计方案 v0.1

> 目标：给一篇论文（或任意长文/报告/网页/代码库说明）做**层层递进的追问**——每一层的问题由上一层答案里的薄弱点触发，每问必答、答后必驳、驳后再追，最后沉淀成一份可复核的「问题树 + 证据分级答案 + 开放问题清单」。
>
> 本文只是方案，不涉及实现。文末列出需要你拍板的 4 个点。

---

## 1. 定位：它补的是哪一段

你机器上已经有两块相邻能力，这个插件不复述它们：

| 已有 | 做什么 | 缺什么 |
|---|---|---|
| `@local/dsh-paper-miner` | 把 PDF 低成本读进来：`paper_scan` / `paper_brief` / `paper_find`，1.5–2.5k token 拿到论证骨架 | 只给「材料」，不给「思考」 |
| `@yunmiao/studymate` | 学习模式：定计划、讲知识、带做项目 | 面向「学一门课」，不是「审一篇论文」 |

中间缺的一层是：**把材料变成一串有依赖关系的问题，并逼出答案的边界**。这就是本插件的位置。

一句话定义：

> **paper-miner 负责「读薄」，追问引擎负责「问深」。**

---

## 2. 目标与非目标

### 目标（v1 必须做到）

1. 输入一篇论文/一段内容，产出**分层问题树**，层与层之间是「由上一层的弱点引出」的依赖关系，不是并列的题目清单。
2. 每个问题都尝试回答，答案标注**证据等级**与**原文锚点**（≤20 字引用或章节位置）。
3. 每层末尾由「审辨者」给出**至少一个替代解释或反例场景**，否则该层不允许推进。
4. 支持「手动推进」（你看一层、决定下一层问什么）与「自动收敛」（跑到无新弱点或预算耗尽）。
5. 产出可离线阅读的 Markdown 报告，落在工作区，可 `present`。

### 非目标（明确不做，避免和已有插件打架）

- 不解析 PDF（复用 paper-miner 的 brief；本插件只吃文本）。
- 不做学习计划/教学（StudyMate 领域）。
- 不做文献综述、不做引用网络分析。
- 不新增 Session 事件类型（不改会话存储格式，只写工具结果 + 私有 ledger）。
- v1 不联网找反例（`web.fetch` 留作可选开关）。

---

## 3. 核心机制

### 3.1 认知阶梯：8 个算子

「层层递进」不是把问题分难易，而是**换一种认知动作**。每一层只使用一个算子，且同一分支上相邻两层不得重复算子（防止原地打转）。

| 层 | 算子 | 要回答的事 | 典型问法（对论文） |
|---|---|---|---|
| L0 | 定位 Orient | 它在哪个问题谱系里、承诺了什么 | 这篇在跟谁竞争？作者承诺的「新」是什么？ |
| L1 | 拆解 Decompose | 论证由哪些断言组成 | 核心断言 3 条是什么？哪条是支柱？ |
| L2 | 前提 Premise | 支撑断言依赖哪些未言明的前提 | 这个结论默认了什么数据分布/硬件/协议？ |
| L3 | 证据 Evidence | 证据是否真的支持结论 | 基线公平吗？指标测的是它声称的东西吗（构念效度）？ |
| L4 | 边界 Boundary | 什么条件下失效 | 构造一个让方法退化的输入；作者的「limitation」之外还有什么？ |
| L5 | 替代 Rival | 还有什么机制能产生同样现象 | 如果是缓存命中率而非批处理，数据会长什么样？怎么区分？ |
| L6 | 预测 Predict | 若主张为真，应观察到什么尚未观察到的现象 | 设计一个 1 天内能做完的证伪实验 |
| L7 | 迁移 Transfer | 抽出的机制能搬到哪里 | 换个领域/换个核心假设，会得到什么新问题 |

> 一般论文在 L1–L4 就已经有大量可挖的弱点；L5–L7 是「研究品味」层，用来产出你自己的新问题。默认 `maxDepth=5`（L0–L4），需要时开到 7。

### 3.2 一轮（一层）的内部流程：三角色对抗

```
提问者 Questioner
  输入：上一层的问题 + 答案 + 审辨者留下的「残留疑问」
  输出：1 个主问题 + ≤3 个子问题，每个问题必须挂一个原文锚点
        │
        ▼
应答者 Answerer
  输入：问题 + 锚点附近的原文片段
  输出：尝试回答 + 每条结论的证据等级 E1–E4 + 承认答不出的部分
        │
        ▼
审辨者 Critic
  输入：问题 + 回答
  输出：弱点清单 / 至少 1 个替代解释或反例 / verdict（pass | needs_more）
        │
        ▼
裁决 ladder.js
  pass      → 该层收敛，进入下一层（算子升级）
  needs_more→ 拆出「残留疑问」，下一层以它为输入（可能同算子下钻 1 次）
  连续 2 次 needs_more 且无新锚点 → 该分支判为 dead-end，记录并换分支
```

证据等级：

| 级别 | 含义 |
|---|---|
| E1 | 原文的实测数据/实验 |
| E2 | 原文的推理或作者断言（无实验） |
| E3 | 领域常识或外部知识（v1 不联网，标注为「待核」） |
| E4 | 我（模型）的假设，明确标记为推测 |

### 3.3 追问守则（硬约束，写进提问者/审辨者的系统提示词并在代码里校验）

1. **锚点强制**：每个问题必须引用原文 ≤20 字的片段或章节 id；无锚点的问题直接丢弃并重生成一次。
2. **可回答性**：问题必须能被回答或被证伪。禁止「这有什么意义/价值」式空问。
3. **由弱点点燃**：新问题必须指向上一层答案中的某一句话（引用它），否则视为跑题。
4. **算子不重复**：同一分支相邻两层算子必须不同；同算子连续下钻最多 1 次。
5. **审辨必有替代**：每层审辨者必须给出 ≥1 个替代解释或反例，否则该层判定不通过。
6. **答案必须分档**：每条结论后必须带 E1–E4 标注，缺标注视为无效回答。
7. **不重复问法**：与已有层的问题做字符级 + 语义近似去重（阈值可配）。

### 3.4 停止与收敛

- 分支收敛：审辨者 `pass` 且无新的残留疑问。
- 深度上限：`maxDepth`（默认 5）。
- 预算上限：`maxCalls`（默认 20 次模型调用）/ `maxTokens`（默认 60k）。
- 用户中断：工具支持取消；已产生的层全部保留。
- 全分支 dead-end：直接进入报告阶段，并把「为什么问不下去」写进报告（这本身是有价值的信息）。

---

## 4. 引擎选型：为什么不是「一段提示词」

| 方案 | 形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 纯提示词** | 只注册一个 skill + 一个轻工具（记录问题树） | 半天能出，零模型路由问题，用户随时插话 | 深度完全靠聊天模型自觉；每层问答都进会话上下文（5 层 ≈ 30k+，长文会挤爆）；层间依赖无法保证 | **不作为主体**，但把它做成 B 的「前门」skill |
| **B Host 内编排** | 插件自己用 `ctx.llm.stream()` 跑三角色 | 会话上下文只留摘要（每层 ~400 token）；层间依赖由代码保证；可复现；可流式展示进度 | 要处理模型路由、凭据、重试、失败码；提示词不进会话日志 | **推荐** |
| **C 子代理** | 每层起一个 subagent 去读原文/联网 | 子 agent 能用工具、能读大文件 | 会话树膨胀、取消/回收复杂、成本难控 | v2 再考虑，只在「需要回读原文」时用 |

选 B 的依据（来自本机 DSH 0.2.2-rc.5 的实时接口）：

- `ctx.llm.stream({ provider, model, system, messages, maxTokens, signal })` 是插件调用模型的**唯一受支持路径**；`system` 字段专为一次性调用者准备。
- `ctx.agentDefaultModel.currentSelection()` 给出会话默认 `{ provider, model }`，可直接继承，也可在 config 里按角色覆盖。
- 每次 stream 必以 `finish` 收尾，失败带稳定错误码（`NO_ADAPTER` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` …），代码按码处理而不是按文本。
- 这属于「辅助模型调用」形态（和会话标题生成、压缩摘要同类），内部提示词不需要进会话日志；**返回给模型的结果**作为工具结果照常入日志。

> 实现细节上的一个决定：不 import `@deepseek-ai/dsh-llm` 的 `BlockAssembler`，自己写 30 行 chunk 组装（只认 `text-delta`）。理由：工作区 bundle 默认不带依赖，避免模块解析在不同安装方式下出问题；`dsh-ops` 那种动态 `import()` 是备选。

---

## 5. 架构与数据流

```
用户 / 聊天模型
   │  inquiry_open(path | url | text)
   ▼
source.js   归一化：PDF → 提示先走 paper_brief；URL → web.fetch（可选）；
            纯文本 → 直通；长文 → 按论证结构切块（不按字数硬切）
   ▼
engine.js   L0 定位（1 次调用）→ 返回「值不值得深挖」的初判
   │
   ├─ inquiry_probe × n（手动推进，或 auto 跑到收敛）
   │     提问者 → 应答者 → 审辨者 → ladder.js 裁决
   │
   ├─ state.js  追加 ledger：~/.dsh/inquiry/<id>/state.json（可断点续跑）
   │
   └─ inquiry_report → <workspace>/inquiry/<slug>.md（全文）
                       会话内只回 ~500 token 摘要 + 文件路径
```

---

## 6. 工具 API

4 个工具，刻意保持少（工具定义本身也吃 prompt，`tool-design` 要求「最小上下文」）。

| 工具 | 作用 | 关键参数 | 返回 | 成本 |
|---|---|---|---|---|
| `inquiry_open` | 建立追问、产出 L0 定位与初判 | `path` / `url` / `text` / `focus`（想追问什么）/ `depth` | `inquiry_id`、L0 定位、「值得深挖的 3 个入口」 | 1–2 call ≈ 3–6k tok |
| `inquiry_probe` | 推进一层 | `inquiry_id`、`operator`（可强制指定算子）、`focus`（本轮盯住什么）、`auto`（跑到收敛） | 该层的问题/答案/审辨/残留 + 下一层候选算子 | 3 call ≈ 8–12k tok |
| `inquiry_view` | 看树或某一层全文 | `inquiry_id`、`layer`、`format` | 缩进问题树 / 单层完整记录 | 0 |
| `inquiry_report` | 生成报告文件 | `inquiry_id`、`path` | 报告路径 + 一页纸摘要 | 1 call ≈ 3k tok |

`inquiry_probe` 的返回样例（进会话的部分，约 400 token）：

```
LAYER L2 · 前提 Premise · verdict needs_more · 累计 14.2k tok

Q2.1 论文把「延迟下降 40%」归因于批处理合并，但实验里批大小同时从 1 改成 32，
     两个变量没有分离。（锚点："we batch up to 32 requests"）
A2.1 原文只报告合并后的数字；消融只对比 batch=1 vs 32，未固定缓存状态。
     证据级别 E2（原文推理，无独立复现）。
C2.1 即使固定批大小，缓存命中率变化也能产生同样的差值。替代解释：连接复用。
     → verdict: needs_more
残留  连接复用未被控制；缓存状态未记录。
下一层候选  L3 证据（查它的消融表）或 L4 边界（构造缓存全冷场景）
```

---

## 7. 状态与落盘

```
~/.dsh/inquiry/<id>/
  state.json   # 追加式 ledger：source 摘要、每层 Q/A/C、算子、verdict、预算消耗
  source.txt   # 归一化后的输入（截断到 N 字，便于重跑）
<workspace>/inquiry/<slug>.md   # 最终报告（可 present）
```

- 工具结果是接口，ledger 是引擎的续跑缓存（DSH 的实践里插件的私有内存就是「派生缓存」）。
- `inquiry_id` 由模型在后续调用里携带；ledger 缺失时 `inquiry_probe` 给出明确错误并要求重新 `inquiry_open`（不静默从头再来）。

---

## 8. UI 方案

| 阶段 | 做什么 | 依据 / 风险 |
|---|---|---|
| v1 | 不做 UI：Markdown 报告 + 工具默认卡片 | 先证明「问得深」 |
| v1.5（推荐紧接着） | `tool.call.toolview`，key = 本插件工具名 → 层级时间线卡片（算子徽标、状态点、点击展开问题/答案/弱点） | 该 slot 的 key 域是开放的，明确包含自定义工具；样式用 `--dsw-alias-*` token |
| v2 | `settings.section` 设置页（深度/模型/预算/输出目录）；`conversation.chat.turnTail` 报告卡（一键打开报告） | 两者都是开放的 list slot |
| 暂缓 | 右侧栏 tab（`sidebar.right.pane.tab`） | 该 slot 由「当前 tab.kind 对应的类型 id」驱动，插件能否注册新的 tab 类型未验证，风险高，实现时再查 |

Client 半边按 `@yunmiao/studymate` 的方式在 `package.json` 里声明 `dsh.client`，不 import 任何 Harness 的 Client 包，控件自己写。

---

## 9. 配置项（写进 `Config`，用户可在 `cordis.patch.yml` 覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxDepth` | 5 | 1–7；5 = L0–L4 |
| `branches` | 2 | 每层子问题数，1–4 |
| `maxCalls` | 20 | 单次追问的模型调用上限 |
| `maxTokens` | 60000 | 单次追问的 token 预算 |
| `roles.questioner/model` | 继承会话默认 | 追问者建议用强模型 |
| `roles.answerer/model` | 继承会话默认 | 应答者可用快模型省钱 |
| `reportDir` | `inquiry/` | 相对工作区 |
| `lang` | `zh` | 报告语言；术语保留英文 |
| `strictAnchors` | `true` | 无锚点问题重生成一次 |

---

## 10. 目录结构

```
dsh-inquiry-ladder/
  package.json            # name: @local/dsh-inquiry-ladder, dsh.bundle.patch
  cordis.patch.yml        # - insert: [{ id: inquiry-ladder, name: ..., config: {} }]
  index.js                # apply(ctx, config)：注册 4 个工具 + skill
  lib/
    ladder.js             # 算子表、去重、停止准则（纯函数，可单测）
    engine.js             # llm.stream 封装、三角色流程、失败码处理
    prompts.js            # 提问者/应答者/审辨者/总结合成 的系统提示词
    source.js             # 输入归一化（text/url/path）、长文切块
    state.js              # ledger 读写
    report.js             # Markdown 渲染（纯函数，可单测）
  skills/deep-inquiry/SKILL.md
  locale/{en,zh}.json     # meta.title / meta.description
  docs/DETAIL.md          # 插件详情页
  icon.svg
```

版本要求与 paper-miner 一致：`"engines": { "dsh": ">=0.2.2-rc.1 <0.2.3-0" }`（本机 0.2.2-rc.5）。

---

## 11. 质量与验证

**纯函数单测**（不依赖模型）
- 算子去重与升级规则；连续 `needs_more` 的 dead-end 判定；预算耗尽时的截断。
- 报告渲染：给定一棵树，输出稳定 Markdown。

**端到端**（用你给的一篇论文）
- `inquiry_open` → 3 次 `inquiry_probe` → `inquiry_report`。
- 人工检查三条硬指标：
  1. 每层问题都引用了上一层答案里的具体句子；
  2. 相邻两层算子不同；
  3. 每条答案都有 E1–E4 标注。
- 打印累计 token/耗时，确认 5 层在 2–4 分钟内、≤60k token。

**安装验证**
- `plugin_manager install_bundle`（绝对路径）→ 读 `application: applied`；
- 新会话里 `cordis_inspect_query` `Tool.listTools` 能看到 4 个新工具；
- 若做 UI：实际页面渲染 + 主题切换 + 空/错/超长三种状态。

---

## 12. 里程碑

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 骨架 + `inquiry_open` 只做 L0，跑通 `llm.stream`（这是最大的技术未知，先打掉） | 0.5 天 |
| P1 | 阶梯引擎：三层 + 三角色 + 守则校验 + ledger 续跑 | 1 天 |
| P2 | `inquiry_report` + skill + locale/icon/DETAIL + 安装验证 | 0.5 天 |
| P3 | v1.5 工具卡片 UI | 0.5–1 天 |
| P4（可选） | 多文档对比、联网找反例、导出 LaTeX/Word | 按需 |

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 插件内模型调用不可用（会话未选模型/无凭据） | 工具直接失败 | 默认继承会话模型；失败时返回可操作的提示（「在输入框选一个模型」），而不是栈 |
| 长文超上下文 | 中途 `CONTEXT_WINDOW_EXCEEDED` | 先把 brief 压到 ≤6k 再逐层扩读；单层只取锚点附近 ±2k 字符 |
| 问题空泛、套路化 | 插件沦为「十万个为什么」 | 守则 1–7 + 审辨者否决 + 重生成一次；报告里显示每层的「锚点覆盖率」 |
| 成本不透明 | 用户不敢用 | 每次返回累计 token/调用数；`maxCalls`/`maxTokens` 硬上限 |
| 工具卡片 slot 渲染崩 | 会话里一块空白 | 卡片纯自绘、无外部依赖；先 v1 文本跑通再上 UI |
| 与 paper-miner 职责重叠 | 用户困惑 | skill 里明确写：PDF 先 `paper_brief`，本插件只吃文本 |

---

## 14. 已定的四个选择（2026-11-26）

1. **引擎形态**：B —— Host 内编排，skill `deep-inquiry` 当前门。
2. **v1 UI**：无 UI，纯 Markdown 报告 + 工具默认卡片。
3. **默认深度**：5 层（L0–L4）。
4. **归属**：独立插件 `@local/dsh-inquiry-ladder`。

实现时相对本方案的两处调整：

- `maxTokens` 默认定为 **150000**（实测一层约 1.2–1.5 万 token，推理模型的思考也计入输出；5 层 + 报告约 8 万，留足余量）。
- 工具返回的 `presentCall` 用通用卡片，不写 Client 半边；`tool.call.toolview` 自定义渲染留到 P3。

## 15. 实现与验证状态

- 交付目录：`dsh-inquiry-ladder/`；已 `install_bundle` 到 `desktop` profile（`application: applied`），并以 link 方式接入。
- 单元测试 17 项 + 端到端接线测试（打桩 llm）通过：`node test/unit.mjs`、`node test/integration.mjs`。
- 真实模型端到端已跑通（`opencode-go / deepseek-v4.1-flash`）：`inquiry_open`（L0 定位、8 条逐字锚点）→ 两次 `inquiry_probe`（L1 拆解、L2 前提，算子自动递进）→ `inquiry_report`（落盘 Markdown）。
- 期间修掉三个真实缺陷：`parameters` 必须是 JSON Schema（注册层不转换）、模型调用必须带 `sessionId`（opencode 路由缺省会 400 `MissingSessionID`）、推理模型会把输出预算耗在思考上（截断时 4 倍预算重试）。
- 成本实测：单层约 1.2–1.5 万 token，三层加报告约 3 万；默认 `maxTokens` 因此从 80000 提到 150000。
- 已知待办：`@local/dsh-paper-miner` 已安装但不在 `dsh.profile.bundles` 里，PDF 流程需先在插件页启用它。
- 输入兼容实测（Host 内）：`.docx` 与 `.pdf` 两条路径都跑通——docx 的 TITLE 取自文档标题、8 条锚点逐字正确；pdf 走本机 `pdftotext`（TeX Live 自带），297 字符全文无丢失。标题曾被文件名带偏，已改为「模型回显文件名时退回正文首行」。
- 科研问题实测：`inquiry_problems(focus="真实部署")` 产出 6 条全部带 qN 锚点、最小验证与风险，分类分布在「部署假设不成立 / 前提脆弱」；`top` 参数此前未被遵守（要 4 给 6），已在 `mineProblems` 里按 top 截断。
- 难度评级实测：第一版把「6 档扫描 × 10 次重复」标成 low，已改为按 firstStep 的可数信号判定（≥5 个配置点 / ≥10 次重复 / 要报 p99.9 任一即 medium），复测 P1=medium、P2=medium、P3=high。
- 输入兼容（2026-11-26 补）：`path` 按扩展名自动抽正文——md/txt/html 直读，docx/pptx/epub 走内置 ZIP+XML 解析，pdf 走外部 `pdftotext` 或 `python + pypdf`（可用 `pdfTool` / `pythonPath` 覆盖），老二进制 Office 与扫描件明确报错。测试见 `test/extract.mjs`。
- 科研问题（2026-11-26 补）：新增 `inquiry_problems`，从证据骨架 + 已推进的层里挖 1–6 条可动手的科研问题（六类、五条硬规则、按可做性×影响排序）；`inquiry_report` 缺问题时自动补挖，报告新增「## 5 现实科研问题」。
- 下一阶段（P3，待确认）：`tool.call.toolview` 自定义层级卡片、`settings.section` 配置页。
