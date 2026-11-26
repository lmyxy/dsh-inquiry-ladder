# inquiry-ladder

> Layered Socratic inquiry over a paper, a report, or any long content: every question is triggered by a weakness in the previous answer, every answer is attacked, and the ladder keeps probing.
> 对一篇论文、一份报告或任意长文做分层追问。

**English** · [中文](README.md)

Not a summariser. It turns the material into a chain of dependent objections, forces out the boundaries of each answer, and ends in a report where every claim points back at a verbatim source quote.

---

## Why not just ask the chat model to question itself

Three roles run inside the Host, one model call each per layer. The conversation only keeps a ~400-token digest per layer:

- **Questioner** — raises the layer's main question. It must quote the source verbatim inside 「」 and name the quote id, and it must be triggered by a specific weakness in the previous answer.
- **Answerer** — attempts an answer and grades every conclusion as `[E1 q3]` (evidence level + anchor): E1 measured in the source, E2 the author's reasoning, E3 unchecked domain knowledge, E4 my own guess. What it cannot answer goes into `unsure`.
- **Critic** — finds what is not supported, and must supply **at least one rival explanation or counterexample**. Without one, the layer is not allowed to advance.

Those rules live in code rather than in the model's goodwill: an unanchored question is regenerated once, a near-duplicate of an earlier question is flagged, and two consecutive layers on one branch may not use the same operator.

## The eight rungs

| Layer | Operator | What it asks |
|---|---|---|
| L0 | Orient | Who is it competing with, and what did the author promise |
| L1 | Decompose | Which assertions carry the argument, and which one is load-bearing |
| L2 | Premise | What does the conclusion quietly assume |
| L3 | Evidence | Is the baseline fair; does the metric measure what it claims to |
| L4 | Boundary | Construct a case that makes it fail |
| L5 | Rival | What other mechanism produces the same effect, and how to tell them apart |
| L6 | Predict | If it is true, what has nobody observed yet |
| L7 | Transfer | Where does the extracted mechanism travel, and what happens if you swap the core assumption |

The default stops at L4 (`maxDepth: 5`). Which rung comes next is decided by the critic's suggestion and the ladder together.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `inquiry_open` | Extracts a quotable evidence skeleton (thesis, claims, evidence, hidden assumptions, verbatim quotes) and returns L0 plus three entry points | 1–2 calls |
| `inquiry_probe` | Advances one layer; `auto: true` keeps going until convergence or budget exhaustion | 3 calls per layer |
| `inquiry_view` | Shows the question tree, or one layer unabridged | free |
| `inquiry_report` | Writes the Markdown report into the workspace | 1 call |

Every call forwards the cancellation signal, so stopping mid-way leaves no half-written record. Ledgers live in `~/.dsh/inquiry/<id>/` and can be resumed.

## Install

```bash
dsh plugin --profile <profile> add <absolute path to this directory>
```

Or in the app: **Plugins** → **Add plugin** → pick this directory. A local directory install is a link, so after editing code, toggle the plugin off and on in the Plugins page to reload it.

## Usage

```
inquiry_open(path: "paper.md", focus: "is its evaluation protocol fair")
inquiry_probe(inquiry_id: "inq_...", operator: "evidence")
inquiry_probe(inquiry_id: "inq_...", auto: true)
inquiry_report(inquiry_id: "inq_...")
```

Do not feed it a PDF directly: run `paper_brief` from paper-miner first, then pass the resulting text as `text`. That saves tokens and, more importantly, keeps the questions anchored to real sentences instead of extraction noise.

## Configuration

Override these in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `maxDepth` | 5 | 1–7 |
| `maxCalls` | 20 | Model-call ceiling per inquiry |
| `maxTokens` | 150000 | Token budget per inquiry |
| `autoMax` | 3 | Layers one `auto: true` call may push through |
| `roles.questioner` / `answerer` / `critic` | session model | Each accepts `{provider, model}`, e.g. a strong questioner and a fast answerer |
| `lang` | `zh` | Report language: `zh`, `en`, or `auto` |
| `strictAnchors` | `true` | Regenerate questions that carry no source anchor |
| `maxSourceChars` | 48000 | Source text cap per inquiry; truncation is stated in the result |
| `reportDir` | `inquiry` | Report directory, relative to the workspace |

## Cost

Measured on `opencode-go / deepseek-v4.1-flash`: about 12–15k tokens per layer, so five layers plus the report is roughly 80k tokens and 3–6 minutes. A reasoning model spends part of the output budget thinking, which is why the default budget is generous; if that matters, set `depth: 3` — three layers are enough to tell whether the material is worth more.

## Known limitations

- No PDF parsing; run `paper-miner` first.
- Long sources are truncated at `maxSourceChars`, and the report states that it happened.
- Ledgers live in `~/.dsh/inquiry/<id>/`; after moving machines or clearing the cache, an inquiry cannot be resumed and needs a fresh `inquiry_open`.
- `url` requires a web service in the profile.
- Report quality follows the chosen model's structured-output ability. If one role's JSON fails to parse twice in a row the tool returns `BAD_JSON`; give that role another model through `roles`. When output is cut off by `maxTokens`, the plugin retries once with four times the budget.

Mechanism, report structure, and verification details: [docs/DETAIL.md](docs/DETAIL.md) (written in Chinese).
