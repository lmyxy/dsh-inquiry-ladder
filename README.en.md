# inquiry-ladder

> Layered Socratic inquiry over a paper, a report, or any document: every question is triggered by a weakness in the previous answer, every answer is attacked, and the ladder ends by naming the research problems you can actually pick up.
> 对一篇论文、一份报告或任意文档做分层追问。

**English** · [中文](README.md)

Not a summariser. It turns the material into a chain of dependent objections, forces out the boundaries of each answer, and then answers "so what can I do with this".

---

## Why not just ask the chat model to question itself

Three roles run inside the Host, one model call each per layer. The conversation keeps only a ~400-token digest per layer:

- **Questioner** — raises the layer's main question. It must quote the source verbatim inside 「」 and name the quote id, and it must be triggered by a specific weakness in the previous answer.
- **Answerer** — attempts an answer and grades every conclusion as `[E1 q3]` (evidence level + anchor): E1 measured in the source, E2 the author's reasoning, E3 unchecked domain knowledge, E4 my own guess. What it cannot answer goes into `unsure`.
- **Critic** — finds what is not supported, and must supply **at least one rival explanation or counterexample**. Without one, the layer is not allowed to advance.

Those rules live in code rather than in the model's goodwill: an unanchored question is regenerated once, a near-duplicate of an earlier question is flagged, and two consecutive layers on one branch may not use the same operator.

## Input formats

Point it at a file and the body text is extracted by extension:

| Format | How |
|---|---|
| `.md` `.txt` `.rst` `.csv` `.json` `.yaml` `.tex` `.bib`, … | read as UTF-8 plain text |
| `.html` | tag stripping, block boundaries kept |
| `.docx` | built-in ZIP + OOXML parsing, heading levels preserved |
| `.pptx` | built-in parsing, slides in numeric order |
| `.epub` | built-in parsing, chapters joined in order |
| `.pdf` | local `pdftotext`, else `python + pypdf` |
| `url` | through the profile's web service |

There is no built-in PDF parser on purpose: real PDF extraction means fonts, CMaps and xref repair, and a half-done one is worse than none. When neither external path exists the tool says so and lists three ways forward instead of quietly returning empty text; scanned PDFs are reported as having no text layer.

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

## Research problems

Once the ladder has run, `inquiry_problems` mines the problems the material leaves open. Every problem must satisfy five rules: it carries a source anchor, it is not a slogan, it names an observable quantity or decision, it says how it relates to the author (already raised — missing what / never raised — why ignored), and it comes with a minimal experiment one person can start within a week.

Six kinds: **unexplained mechanism**, **deployment assumption breaks**, **evaluation blind spot**, **data gap**, **not transferred yet**, **fragile premise**. They are ranked by feasibility × impact, so the first one is the one to start on. `inquiry_report` mines a round automatically when you did not, so a report never ends as criticism without an exit.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `inquiry_open` | Extracts the text and a quotable evidence skeleton (thesis, claims, evidence, hidden assumptions, stated limitations, future work, verbatim quotes) | 1–2 calls |
| `inquiry_probe` | Advances one layer; `auto: true` keeps going until convergence or budget exhaustion | 3 calls per layer |
| `inquiry_problems` | Mines 1–6 research problems | 1 call |
| `inquiry_view` | Shows the question tree, or one layer unabridged | free |
| `inquiry_report` | Writes the Markdown report, research problems included | 1–2 calls |

Every call forwards the cancellation signal, so stopping mid-way leaves no half-written record. Ledgers live in `~/.dsh/inquiry/<id>/` and can be resumed.

## Install

```bash
dsh plugin --profile <profile> add <absolute path to this directory>
```

Or in the app: **Plugins** → **Add plugin** → pick this directory. A local directory install is a link, so after editing code, toggle the plugin off and on in the Plugins page to reload it.

## Usage

```
inquiry_open(path: "paper.docx", focus: "is its evaluation protocol fair")
inquiry_probe(inquiry_id: "inq_...", operator: "evidence")
inquiry_problems(inquiry_id: "inq_...", focus: "real deployment")
inquiry_report(inquiry_id: "inq_...")
```

## Configuration

Override these in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `maxDepth` | 5 | 1–7 |
| `maxCalls` | 20 | Model-call ceiling per inquiry |
| `maxTokens` | 150000 | Token budget per inquiry |
| `autoMax` | 3 | Layers one `auto: true` call may push through |
| `roles.questioner` / `answerer` / `critic` | session model | Each accepts `{provider, model}`, e.g. a strong questioner and a fast answerer |
| `pdfTool` | empty | Absolute path to `pdftotext`, overriding auto-detection |
| `pythonPath` | empty | Absolute path to an interpreter with `pypdf` |
| `lang` | `zh` | Report language: `zh`, `en`, or `auto` |
| `strictAnchors` | `true` | Regenerate questions that carry no source anchor |
| `maxSourceChars` | 48000 | Source text cap per inquiry; truncation is stated in the result |
| `reportDir` | `inquiry` | Report directory, relative to the workspace |

## Cost

Measured on `opencode-go / deepseek-v4.1-flash`: about 12–15k tokens per layer, so one layer of inquiry plus a round of research problems plus the report lands around 30–40k. A reasoning model spends part of the output budget thinking, which is why the default budget is generous; if that matters, set `depth: 3` — three layers are enough to tell whether the material is worth more.

## Known limitations

- PDF extraction depends on an external tool; without `pdftotext` / `pypdf` the call fails with `PDF_NO_BACKEND` and three alternatives.
- Scanned or image-only PDFs need OCR first.
- Long sources are truncated at `maxSourceChars`, and the report states that it happened.
- Ledgers live in `~/.dsh/inquiry/<id>/`; after moving machines or clearing the cache, an inquiry cannot be resumed and needs a fresh `inquiry_open`.
- Report quality follows the chosen model's structured-output ability. If one role's JSON fails to parse twice in a row the tool returns `BAD_JSON`; give that role another model through `roles`. When output is cut off by `maxTokens`, the plugin retries once with four times the budget.

Mechanism, report structure, and verification details: [docs/DETAIL.md](docs/DETAIL.md) (written in Chinese).
