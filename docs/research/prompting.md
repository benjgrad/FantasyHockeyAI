# Prompting Claude — research for FantasyHockeyAI

Retrieved **2026-09-24** from official Anthropic documentation (`platform.claude.com/docs`,
`code.claude.com/docs`, `anthropic.com/engineering`). Every substantive claim carries a source
URL. Claims I could not verify are collected in **§9 Contradictions and uncertainties** rather
than smoothed over.

> **Doc-host note.** `docs.claude.com/en/docs/...` now 302-redirects to
> `platform.claude.com/docs/en/...`. Both spellings appear in search results; the
> `platform.claude.com` form is canonical as of the retrieval date. Some older slugs have moved
> (see §9).

---

## 0. Applies to this project — the 10 rules

1. **Stop relying on forced tool calls as the *mechanism*; rely on `strict: true`.** `tool_choice`
   `any`/`tool` now returns a **400** on Claude Opus 5.5, Fable 5.1 and Mythos 5.1. The documented
   replacement is `tool_choice: auto` + `strict: true` on the tool (grammar-constrained sampling
   guarantees schema-valid inputs), or `output_config.format` when you only wanted JSON back.
   P4 should be restated as *"structured decisions use schema-constrained tool calls"* and the
   `tool_choice` value should be a per-model config knob, not a hardcoded `any`.
2. **Put `strict: true` + `additionalProperties: false` + `required` on every `propose` tool.**
   Without it Claude can emit `"2"` where you asked for `2`, or omit a required field; with it the
   API guarantees the `input` validates and that `name` is a real tool. This is a stronger
   guarantee than zod-validating after the fact, and it removes a retry class.
3. **Constrain IDs in the schema, not just in the prose.** Where the candidate set is small and
   known (the lineup slate, the waiver shortlist), emit the playerKeys as a JSON-Schema `enum` in
   the tool's `input_schema`. Under `strict: true` the sampler *cannot* produce a key outside the
   enum, which enforces P3 at the decoding layer instead of at validation time. Keep the index
   resolution anyway — belt and braces — but the enum turns "model typed a fake key" from a
   runtime error into an impossibility.
4. **Tool descriptions are the highest-leverage prompt surface you have.** Anthropic: "Provide
   extremely detailed descriptions. This is by far the most important factor in tool performance…
   Aim for at least 3–4 sentences for each tool description, more if the tool is complex." Say what
   the tool does, when it should be used *and when it shouldn't*, what each parameter means, and
   what the tool does **not** return.
5. **Cache the league context; keep the job input below the breakpoint.** Order is
   `tools` → `system` → `messages`; any byte change in a prefix invalidates everything after it.
   Put roster/league settings/scoring in the system array with `cache_control`, and put the date,
   the slate and the per-run variables in the user message. A `new Date()` above the breakpoint
   silently costs you the whole cache. Verify with `usage.cache_read_input_tokens`.
6. **Give the model a first-class way to abstain, and make it a tool.** Anthropic's own
   anti-hallucination guidance leads with "Allow Claude to say 'I don't know'". For P5, that means
   a `no_action` / `abstain` tool with a `reason` field in the same allow-list as the real
   proposals — not a prose escape hatch and not a nullable field it has to guess its way into.
   Under `tool_choice: auto` the model can then decline without you fighting a forced call.
7. **Check `stop_reason` against the complete enumerated set, not just `end_turn`/`tool_use`.**
   The full set is `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`,
   `model_context_window_exceeded`. P6's "every stop reason gets a name" should enumerate all
   seven. Two specific traps: `max_tokens` with a trailing `tool_use` block is a *truncated tool
   call*, not a valid one; and thinking tokens count toward `max_tokens` even when the thinking
   text isn't returned to you.
8. **Delete the "CRITICAL / you MUST / double-check your work" language.** Current models
   over-trigger on aggressive prompting, and Anthropic explicitly says Opus 5 verifies its own
   work — "If your prompt contains explicit verification instructions… remove them: instructions
   like these cause over-verification on Claude Opus 5". Plain "Use this tool when…" outperforms
   "CRITICAL: You MUST use this tool when…".
9. **Structure the YAML prompt bodies with XML tags and put bulk context first.** Anthropic
   measures up to **~30% better response quality** from putting long inputs at the top and the
   query at the end, and recommends wrapping each content type in its own tag
   (`<instructions>`, `<league_context>`, `<slate>`, `<examples>`). This composes well with strict
   `{{var}}` interpolation: one tag per interpolated block makes an unrendered placeholder visible.
10. **Evals: judge with a different model than the generator, and give it a numbered rubric with
    anchors.** Anthropic's eval guidance says to use a separate model for grading, state the scale
    explicitly ("1: … 5: …"), and specify the output format ("Output only the number"). Pinning the
    judge to `claude-sonnet-5` while agents run on a different model already satisfies the first
    point; the rubric-anchoring point is the one most projects skip.

---

## 1. Anthropic's current prompt-engineering guidance

### 1.1 The docs reorganised — there is no longer a ranked technique list

The old `prompt-engineering/overview` page used to present techniques "in order of broad
effectiveness" with one subpage each (be-clear-and-direct, multishot-prompting, chain-of-thought,
use-xml-tags, system-prompts, prefill-claudes-response, chain-prompts, long-context-tips). As of
2026-09-24 that page is a stub that says:

> "All prompting techniques (from clarity and examples to XML structuring, role prompting,
> thinking, and prompt chaining) are covered in **Prompting best practices**. That's the living
> reference; start there."
> — <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview>

The living reference is organised **by topic, not by priority**:
*Model-specific guidance* → *General principles* → *Output and formatting* → *Tool use* →
*Thinking and reasoning* → *Agentic systems* → *Capability-specific tips* → *Migration
considerations*.
— <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices>

**I did not find a current, authoritative "priority order".** The closest thing to one is the
structural ordering above plus the standing prerequisite on the overview page: you should already
have (1) success criteria, (2) a way to test empirically, (3) a draft prompt, before you prompt-
engineer at all. Do not cite a ranked list as Anthropic's current position.

### 1.2 Be clear and direct

> "Think of Claude as a brilliant but new employee who lacks context on your norms and workflows."
> **Golden rule:** "Show your prompt to a colleague with minimal context on the task and ask them
> to follow it. If they'd be confused, Claude will be too."

- Be specific about desired output format and constraints.
- Use numbered lists / bullets when order or completeness of steps matters.
- If you want "above and beyond" behaviour, ask for it explicitly rather than hoping it's inferred.

Worked example from the page — less effective: `Create an analytics dashboard`; more effective:
`Create an analytics dashboard. Include as many relevant features and interactions as possible. Go
beyond the basics to create a fully-featured implementation.`

### 1.3 Add context / motivation to instructions

Explaining *why* a rule exists generalises better than the bare rule.

- Less effective: `NEVER use ellipses`
- More effective: `Your response will be read aloud by a text-to-speech engine, so never use
  ellipses since the text-to-speech engine will not know how to pronounce them.`

> "Claude is smart enough to generalize from the explanation."

**For this project:** `Only use playerKeys returned by tools` is the weak form. The strong form is
`Only use playerKeys returned by tools. Every key you emit is resolved against the league index
before anything executes, and a key that is not in the index aborts the whole proposal — so a
guessed or remembered key silently kills the run.`

### 1.4 Examples (multishot)

> "Examples are one of the most reliable ways to steer Claude's output format, tone, and
> structure."

Make them:
- **Relevant** — mirror the real use case.
- **Diverse** — cover edge cases, vary enough that Claude doesn't latch onto an unintended pattern.
- **Structured** — wrap in `<example>` tags, multiple in `<examples>`, so they're distinguishable
  from instructions.

> "Include 3–5 examples for best results."

You can also ask Claude to evaluate your examples for relevance/diversity, or to generate more.

The context-engineering essay makes the complementary point: don't try to enumerate every edge
case in prose — curate "diverse, canonical examples that effectively portray the expected
behavior", which act as compressed representations of the desired pattern.
— <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

### 1.5 XML tags

> "XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes
> instructions, context, examples, and variable inputs."

- Use consistent, descriptive tag names across prompts.
- Nest when there's a natural hierarchy (`<documents>` → `<document index="n">`).

### 1.6 Role / system prompt

Setting a role in the **system** prompt focuses behaviour and tone; "even a single sentence makes
a difference". The documented split is: role and standing behaviour in `system`, the task in the
user message. The best-practices page has no separate "system vs user" theory section beyond this
— the role goes in `system`, the job goes in `messages`.

Two current, relevant refinements:

- **Mid-conversation system messages.** On Claude Opus 5, Opus 4.8, Fable 5/5.1 and Mythos 5/5.1
  (not Sonnet 5), you can append `{"role": "system", "content": "..."}` to the `messages` array
  instead of editing the top-level `system` field. This adds an operator instruction without
  invalidating the cached prefix, and is the prompt-injection-safe operator channel. It must
  follow a `user` message and can't be `messages[0]`.
  — <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- **Context hydration without prefill.** For long conversations, inject what used to be prefilled
  assistant reminders into the *user* turn, or hydrate through tools.

### 1.7 Chain of thought → adaptive thinking

Explicit "think step by step" scaffolding is largely superseded. On Claude 4.6+ models the
recommended configuration is `thinking: {type: "adaptive"}`; on Fable 5/5.1, Mythos 5/5.1 and
Opus 5.5 thinking is **always on** and adaptive is the only mode. Depth is controlled by
`output_config.effort` (`low`/`medium`/`high`/`xhigh`/`max`).

> "In internal evaluations, adaptive thinking reliably drives better performance than extended
> thinking."

You can still *steer* thinking with prose:

```
After receiving tool results, carefully reflect on their quality and determine optimal
next steps before proceeding. Use your thinking to plan and iterate based on this new
information, and then take the best next action.
```

and steer it *down* when a large system prompt makes the model think too often:

```
Thinking adds latency and should only be used when it will meaningfully improve
answer quality - typically for problems that require multistep reasoning. When in
doubt, respond directly.
```

`budget_tokens` is deprecated on Opus 4.6 / Sonnet 4.6 and returns a **400** on Claude 4.7 and
later. Use `effort` for cost control and `max_tokens` as the hard ceiling.

### 1.8 Prefill is gone

> "Starting with Claude 4.6 models and Claude Mythos Preview, prefilled responses (providing a
> partial assistant message for Claude to continue from) on the last assistant turn are no longer
> supported. Requests with prefilled assistant messages to these models return a 400 error."

Documented migrations for each classic prefill use:

| Prefill was used for | Migrate to |
|---|---|
| Forcing JSON/YAML/classification shape | **Structured outputs** (`output_config.format`), or a tool with an `enum` field for classification |
| Eliminating preambles (`Here is the summary:\n`) | System instruction "Respond directly without preamble…", or XML tags, or structured outputs, or tool calling; strip stragglers in post-processing |
| Steering around bad refusals | Clear prompting in the `user` message; refusals are better calibrated now |
| Continuations after truncation | Move to the user message: "Your previous response was interrupted and ended with `[previous_response]`. Continue from where you left off." — **or just retry** if there's no UX penalty |
| Context hydration / role consistency | Inject into the user turn, or hydrate through tools, or via compaction |

Prefill is also explicitly **incompatible with JSON outputs**.

### 1.9 Long-context prompting (20k+ tokens)

- **Put longform data at the top**, above your query, instructions and examples.
  > "Queries at the end can improve response quality by up to 30 percent in tests, especially with
  > complex, multidocument inputs."
- **Wrap documents in XML** with `<document index="n">`, `<source>`, `<document_content>` subtags.
- **Ground responses in quotes:** ask Claude to extract relevant verbatim quotes into `<quotes>`
  tags *first*, then do the task based only on those quotes.

### 1.10 Output-format control

Four documented levers, in the page's own order:
1. Tell Claude what to do, not what not to do.
2. Use XML format indicators (`Write the prose sections in <smoothly_flowing_prose_paragraphs>
   tags`).
3. Match your prompt's style to the desired output style (removing markdown from your prompt
   reduces markdown in the output).
4. Use detailed prompts for specific formatting preferences.

---

## 2. Tool use / function calling

Primary sources:
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use>
- <https://www.anthropic.com/engineering/writing-tools-for-agents>

### 2.1 Writing tool definitions — Anthropic's five best practices, verbatim intent

1. **Provide extremely detailed descriptions.** "This is by far the most important factor in tool
   performance." Cover: what the tool does; when it should be used **and when it shouldn't**; what
   each parameter means and how it affects behaviour; caveats and limitations, including *what
   information the tool does not return*. "Aim for at least 3–4 sentences for each tool
   description, more if the tool is complex."
2. **Prioritize descriptions, but use `input_examples` for complex tools** — an optional array of
   schema-validated example input objects. Best for nested objects, optional parameters, and
   format-sensitive inputs. Costs ~20–50 tokens for simple examples, ~100–200 for complex nested
   ones. Invalid examples return a 400. Not supported on server tools or the computer/browser
   toolsets.
3. **Consolidate related operations into fewer tools.** Rather than `create_pr` / `review_pr` /
   `merge_pr`, use one tool with an `action` parameter. "Fewer, more capable tools reduce selection
   ambiguity."
4. **Use meaningful namespacing in tool names** — `github_list_prs`, `slack_send_message`.
   (For this project: `yahoo_roster_get`, `nhl_schedule_get`, `propose_lineup`, `propose_waiver`.)
5. **Design tool responses to return only high-signal information.** "Return semantic, stable
   identifiers (for example, slugs or UUIDs) rather than opaque internal references, and include
   only the fields Claude needs to reason about its next step."

Anthropic's own contrast pair:

```json
// GOOD
{
  "name": "get_stock_price",
  "description": "Retrieves the current stock price for a given ticker symbol. The ticker symbol must be a valid symbol for a publicly traded company on a major US stock exchange like NYSE or NASDAQ. The tool will return the latest trade price in USD. It should be used when the user asks about the current or most recent price of a specific stock. It will not provide any other information about the stock or company.",
  "input_schema": { "type": "object", "properties": { "ticker": { "type": "string", "description": "The stock ticker symbol, e.g. AAPL for Apple Inc." } }, "required": ["ticker"] }
}

// POOR
{ "name": "get_stock_price", "description": "Gets the stock price for a ticker.",
  "input_schema": { "type": "object", "properties": { "ticker": { "type": "string" } }, "required": ["ticker"] } }
```

`name` must match `^[a-zA-Z0-9_-]{1,128}$`.

### 2.2 From *Writing tools for agents* (engineering blog)

- **Don't wrap every endpoint.** "More tools don't always lead to better outcomes." Build tools
  around the workflow, consolidating multi-step operations (`schedule_event` rather than
  list+create).
- **Prefer semantic identifiers over opaque ones.** "Resolving arbitrary alphanumeric UUIDs to
  more semantically meaningful and interpretable language… significantly improves Claude's
  precision." Where both are needed, expose a `response_format` enum (`"concise"` /
  `"detailed"`).
  - *Tension with P3 for this project:* Yahoo `playerKey`s are opaque (`nhl.p.NNNN`). The blog's
    advice argues for returning `"Connor McDavid (EDM, C) [nhl.p.3737]"` shaped rows so the model
    reasons over names but emits keys — while the schema `enum` (rule 3 in §0) is what actually
    prevents fabrication.
- **Token efficiency:** paginate, filter, truncate with sensible defaults; when truncating, steer
  the agent with helpful instructions toward targeted rather than broad searches.
- **Error messages must be actionable**, not opaque codes — specific, correctable suggestions that
  guide the agent to proper usage.
- **Evaluate tools like prompts:** realistic multi-tool tasks, dozens of grounded prompt/response
  pairs, and metrics beyond accuracy — runtime, call counts, token consumption, error counts.

### 2.3 `tool_choice` — options and model restrictions ⚠️

The four options:

| Option | Meaning |
|---|---|
| `auto` | Claude decides whether to call any tool. **Default when `tools` are provided.** |
| `any` | Claude must use one of the provided tools, but not a particular one. |
| `tool` | Forces a specific named tool. |
| `none` | Prevents any tool use. Default when no `tools` are provided. |

**Where forced tool use is unsupported** (verbatim from the Define tools table):

| Model or setting | Restriction | What to use instead |
|---|---|---|
| Manual extended thinking (`thinking: {type: "enabled"}`) | `any` and `tool` not supported, result in an error | `auto` or `none`. *Adaptive* thinking does **not** block forced tool use — "Claude Opus 5 supports it with thinking on" |
| **Claude Opus 5.5, Claude Fable 5.1, Claude Mythos 5.1** | `any` and `tool` return a **400 error** | `auto` with **strict tool use** to guarantee schema-valid tool inputs, or **structured outputs** when you need a fixed JSON shape. "Prompting still influences which tool `auto` picks." `none` is also supported |

Release-note dates: **2026-09-01** for Fable 5.1 / Mythos 5.1; **2026-09-22** for Opus 5.5.
— <https://platform.claude.com/docs/en/release-notes/api>

Corroborating signal: the tool-use token table lists an `any, tool` column value for every model
*except* Claude Opus 5.5, which has only the `auto, none` figure (286 tokens).

Two more `tool_choice` facts that matter here:

- **Forced tool use suppresses preamble text.** "When you have `tool_choice` as `any` or `tool`,
  the API prefills the assistant message to force a tool to be used. This means that the models
  will not emit a natural language response or explanation before `tool_use` content blocks, even
  if explicitly asked to do so." If you want a rationale string alongside the decision, either put
  it *in the tool schema* (recommended for P10 logging) or use `auto` plus an explicit instruction.
- **Changing `tool_choice` invalidates cached message blocks** (tool definitions and system prompt
  stay cached). So don't flip `tool_choice` per-request across an otherwise-cacheable conversation.

### 2.4 Steering tool triggering from the prompt

> "This boundary is steerable through your system prompt. If Claude isn't calling tools when you
> expect, a light instruction such as `"Use the tools to investigate before responding."`
> increases tool use. A stronger form such as `"Always call a tool first before responding."`
> pushes further. Conversely, `"Use your judgment about whether to call a tool or respond
> directly."` keeps triggering behavior conservative."

And, critically for a project migrating prompts forward:

> "Claude Opus 4.5 and Claude Opus 4.6 are also more responsive to the system prompt than previous
> models. If your prompts were designed to reduce undertriggering on tools or skills, these models
> may now overtrigger. The fix is to dial back any aggressive language. Where you might have said
> 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this
> tool when...'."

### 2.5 Missing required parameters

> "If the user's prompt doesn't include enough information to fill all the required parameters for
> a tool, Claude Opus is much more likely to recognize that a parameter is missing and ask for it.
> Claude Sonnet might ask, especially when prompted to think before outputting a tool request. But
> it might also infer a reasonable value."

**Direct relevance to P3/P5:** Sonnet-class models will *guess* a missing parameter. If any
FantasyHockeyAI agent runs on Sonnet, an under-specified job input can produce a confidently
fabricated playerKey. The mitigations are the schema `enum`, the index resolution, and an explicit
abstain tool.

### 2.6 Parallel tool use

- On by default; one assistant message may contain multiple `tool_use` blocks.
- Execute them concurrently and return **all** `tool_result` blocks in a **single** user message.
  Splitting them across messages trains Claude to stop making parallel calls.
- For a failed tool, return a `tool_result` with `is_error: true` — don't drop it.
- `disable_parallel_tool_use: true` nests inside the `tool_choice` object
  (`{"type": "auto", "disable_parallel_tool_use": true}`), giving at most one call per turn.
- Anthropic's prompt for ~100% parallel-call reliability, quoted in full, ends with the line that
  matters most here: **"Never use placeholders or guess missing parameters in tool calls."**

```
<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool
calls, make all of the independent tool calls in parallel. Prioritize calling tools
simultaneously whenever the actions can be done in parallel rather than sequentially.
For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into
context at the same time. Maximize use of parallel tool calls where possible to increase
speed and efficiency. However, if some tool calls depend on previous calls to inform
dependent values like the parameters, do NOT call these tools in parallel and instead
call them sequentially. Never use placeholders or guess missing parameters in tool
calls.
</use_parallel_tool_calls>
```

### 2.7 Common tool-definition mistakes (synthesised from the above)

- One-line descriptions (the "poor" example above).
- Parameters with a type but no `description`.
- A sprawl of near-identical tools where a human couldn't say which applies — "agents won't
  perform better than humans in such ambiguous scenarios"
  (<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>).
- Bloated tool responses that waste context.
- Ambiguous parameter names (`user` instead of `user_id`).
- Omitting `additionalProperties: false` / `required` when using `strict: true` — the schema is
  then rejected.
- Assuming forced tool use is universally available (§2.3).
- Raw string-matching on the serialized tool `input` — Claude 4.6+ models may vary JSON string
  escaping (Unicode, forward slashes). Always `JSON.parse`.

---

## 3. Structured output — current best practice

**Short answer: there is now a native, GA, schema-constrained mode, and it is the recommended
mechanism. Forced tool calls are no longer the only — or on the newest models, an available —
route.**

Source: <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>

### 3.1 Two complementary features

| Feature | Field | Guarantees |
|---|---|---|
| **JSON outputs** | `output_config: { format: { type: "json_schema", schema: {...} } }` | The response's text content block is valid JSON matching your schema |
| **Strict tool use** | `strict: true` on a tool definition (top-level, beside `name`/`description`/`input_schema`) | `tool_use.input` strictly follows `input_schema`; `tool_use.name` is always a valid tool name |

Both use **grammar-constrained sampling** — the schema constrains token sampling, so invalid
output is not merely rejected, it is unreachable. They can be combined in one request.

> "For example, suppose a booking system needs `passengers: int`. Without strict mode, Claude might
> provide `passengers: "two"` or `passengers: "2"`. With `strict: true`, the response always
> contains `passengers: 2`."

### 3.2 Timeline (from the API release notes) — dates and versions

| Date | Change |
|---|---|
| **2025-11-14** | Structured outputs launched in **public beta** with header `structured-outputs-2025-11-13` (Sonnet 4.5 / Opus 4.1 at announcement) |
| **2025-12-04** | Support added for Claude Haiku 4.5 |
| **2026-01-29** | **Out of beta** on the Claude API for Sonnet 4.5, Opus 4.5, Haiku 4.5. The `output_format` parameter **moved to `output_config.format`**. Beta continued on Bedrock and Foundry |
| **2026-09-01** | Forced `tool_choice` `any`/`tool` → 400 on Fable 5.1 / Mythos 5.1; docs point to strict tool use / structured outputs as the replacement |
| **2026-09-22** | Same for Claude Opus 5.5 |

— <https://platform.claude.com/docs/en/release-notes/api>

**`output_format` is deprecated; use `output_config: {format: {...}}`.**

### 3.3 Supported models and platforms (as listed on the docs page, 2026-09-24)

Models: Fable 5 and 5.1; Mythos 5, 5.1 and Preview; Opus 4.5, 4.6, 4.7, 4.8, 5 and 5.5; Sonnet
4.5, 4.6 and 5; Haiku 4.5.
Platforms: Claude API, Claude Platform on AWS, Amazon Bedrock, Google Cloud, Microsoft Foundry.
(On Bedrock: Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5, Haiku 4.5 only.)

### 3.4 JSON Schema limitations (shared by both features)

**Supported:** basic types, `enum`, `const`, `anyOf`, `allOf`, `$ref`; string `format` values
including `date-time`, `date`, `email`, `uri`, `uuid`; array `minItems` — **but only 0 or 1**.

**Not supported:** recursive schemas; external `$ref`; numeric/length constraints (`minimum`,
`maximum`, `minLength`, `maxLength`); complex types within enums.

The SDKs' schema transformation handles unsupported constraints by moving them into descriptions
and validating the response locally — so a zod schema with `.min(1).max(20)` still *works*, but the
bound is enforced client-side, not by the sampler. **Design the zod schemas so the guarantees you
actually depend on (which fields exist, which literal IDs are legal) live in the supported subset.**

### 3.5 Feature compatibility

**Works with:** batch processing (50% discount), token counting, streaming, and combined
JSON-outputs + strict-tool-use in one request.

**Incompatible with:**
- **Citations** — returns 400 if citations are enabled together with `output_config.format`.
- **Message prefilling** — incompatible with JSON outputs (and prefill is a 400 on 4.6+ anyway).

### 3.6 Cost / latency / caching implications

- An additional system prompt explaining the output format is injected automatically → slightly
  higher input token count.
- **Changing `output_config.format` invalidates the prompt cache for that conversation thread.**
- First request with a new schema pays extra latency for **grammar compilation**; compiled
  grammars are cached for **24 hours**, invalidated by schema or tool-set changes.
- Data retention: prompts/responses are processed under ZDR; the **schema itself** is cached up to
  24h. **Do not put sensitive data in schema property names, `enum` values, `const` values, or
  `pattern` regexes** — those are cached separately and, per the HIPAA note, are not covered by the
  same protections as message content. (Relevant here only insofar as a per-user schema with
  personal identifiers would leave the ZDR envelope.)
- The computer-use and browser-use toolset entries reject `strict: true`.

### 3.7 Recommendation for P4

Restate P4 as: *structured decisions use a **schema-constrained** tool call — `strict: true`, with
`additionalProperties: false` and an explicit `required` list — never free-form JSON in prose.*
Keep `tool_choice: {type: "any"}` **only** as a model-conditional optimisation while the agents run
on a model that accepts it (Opus 5, Sonnet 5, Opus 4.8 and earlier), and treat `auto` + strict +
a named-tool instruction in the prompt as the portable default.

---

## 4. Prompt caching

Source: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>

### 4.1 Mechanism

Caching is a **prefix match** over the rendered request. Render order is
**`tools` → `system` → `messages`**. Any byte change anywhere in the prefix invalidates everything
after it.

Two ways to place a breakpoint:

```jsonc
// 1. Automatic: one field at the top level of the request.
//    The system applies the breakpoint to the last cacheable block and moves it forward
//    as the conversation grows. Best for multi-turn chat.
{ "cache_control": {"type": "ephemeral"}, "system": "...", "messages": [...] }

// 2. Explicit: cache_control on an individual content block. Fine-grained.
{ "system": [ { "type": "text", "text": "<large static context>",
               "cache_control": {"type": "ephemeral"} } ] }
```

### 4.2 What is cacheable

Tool definitions (the `tools` array); system content blocks; text messages in both user and
assistant turns; images and documents in user turns; tool use and tool result blocks in both turns.

**Not cacheable directly:** thinking blocks — but they *are* cached alongside other content in
previous assistant turns and count as input tokens when read.

### 4.3 Minimum cacheable prefix (model-dependent)

| Minimum | Models |
|---|---|
| 512 tokens | Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Fable 5, Mythos 5 |
| 1,024 tokens | Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5 |
| 2,048 tokens | Mythos Preview, Opus 4.7 |
| 4,096 tokens | Opus 4.6, Opus 4.5, Haiku 4.5 |

**A prefix below the minimum silently does not cache.** (See §9 — these per-model figures came
from a page summarisation and should be re-read against the live table before you size a prefix
near a boundary.)

### 4.4 Breakpoints, lookback, TTL

- **Maximum 4 breakpoints per request.**
- **Lookback window: 20 blocks** — the system checks that many positions backward for prior cache
  entries.
- **TTL: 5 minutes (default) or 1 hour** (`{"type": "ephemeral", "ttl": "1h"}`). The 1-hour TTL no
  longer requires a beta header (release note 2025-08-13). Cache is refreshed at no cost when
  reused within the TTL.

### 4.5 Pricing multipliers

| Component | Cost |
|---|---|
| 5-minute cache write | 1.25× base input |
| 1-hour cache write | 2× base input |
| Cache hit / refresh | 0.1× base input (Fable 5.1 / Mythos 5.1: 0.025×; Opus 5.5: 0.05×) |
| Output tokens | Unchanged |

### 4.6 What invalidates the cache (hierarchical)

| Change | Impact |
|---|---|
| Tool definitions | Entire cache invalidated |
| Web search / citations toggle | System + messages |
| `speed` setting (fast mode) | System + messages |
| `tool_choice` | Messages only |
| Images added/removed | Messages only |
| Thinking parameters | Messages always; tools/system model-specific |
| `output_config.format` (structured outputs) | That conversation thread's cache |

### 4.7 Recommended shape for a FantasyHockeyAI agent request

```
tools:      [read tools..., propose tools...]          ← stable; frozen per agent version
                                                          (a tool-list change nukes everything)
system: [
  { text: "<role + decision policy>",              cache_control: ephemeral }   ← breakpoint 1
  { text: "<league settings, scoring, roster rules, team identity>",
                                                    cache_control: ephemeral }   ← breakpoint 2
  { text: "<player pool / eligible index for today>",
                                                    cache_control: ephemeral }   ← breakpoint 3
]
messages: [ { role: user, content: "<date, slate, injuries, the specific job>" } ]  ← NOT cached
```

Rationale, from the page's own best-practice list: "Place `cache_control` on the last identical
block across requests"; "Put static content first (system instructions, context, examples)";
"Avoid placing breakpoint on changing content (timestamps, per-request context, user messages)";
"Use explicit breakpoints for different change frequencies".

Three breakpoints for three different change frequencies (role: per deploy; league settings: per
season; player pool: per day) leaves one spare of the four.

### 4.8 Verification and pre-warming

Monitor `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.input_tokens`
(tokens after the last breakpoint). Total = read + creation + input. **If `cache_read_input_tokens`
is zero across repeated requests, a silent invalidator is at work** — a `new Date()` in the system
prompt, unsorted JSON key order, a varying tool set.

Pre-warm with `max_tokens: 0` before a latency-sensitive window (e.g. before the daily lineup-lock
run):

```python
client.messages.create(model=..., max_tokens=0,
    system=[{"type":"text","text":"<system prompt>","cache_control":{"type":"ephemeral"}}],
    messages=[{"role":"user","content":"warmup"}])
```

---

## 5. Stop reasons and failure modes

Sources:
- <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>
- <https://platform.claude.com/docs/en/api/handling-stop-reasons>

### 5.1 The complete set

| `stop_reason` | When it occurs | What to do |
|---|---|---|
| `end_turn` | Claude finished naturally | Use the response |
| `max_tokens` | Hit your `max_tokens` limit | **Truncation.** Raise `max_tokens` or continue |
| `stop_sequence` | Emitted one of your `stop_sequences` | Read `stop_sequence` to see which fired |
| `tool_use` | Claude is calling a tool | Execute and return `tool_result` blocks |
| `pause_turn` | A server-tool loop hit its iteration limit (default 10) | Send the assistant content back unchanged to continue |
| `refusal` | Claude declined | Read `stop_details`; retry on a fallback model |
| `model_context_window_exceeded` | Response filled the model's context window | **Treat as truncated** |

**P6 implication:** the exhaustive-switch in the project's code must cover all seven. Two of them —
`pause_turn` and `model_context_window_exceeded` — are recent additions that older handlers miss.

### 5.2 Detecting truncation

```python
if response.stop_reason in ("max_tokens", "model_context_window_exceeded"):
    # the response was cut off — do not treat it as a short valid answer
```

**The specific trap for structured decisions:** a truncated *tool call*.

```python
if response.stop_reason == "max_tokens" and response.content[-1].type == "tool_use":
    # the tool input is incomplete — retry with a higher max_tokens
```

Note that under `eager_input_streaming` / fine-grained tool streaming the API does **not**
validate or coerce the input, so the accumulated `partial_json` may parse into a *silently
truncated* object rather than raising. Guard the parse and re-validate against the schema before
acting. Under `strict: true` without eager streaming, a completed call is schema-valid by
construction — but a call cut off by `max_tokens` is still a partial call.

### 5.3 `max_tokens` × thinking

> "Both the thinking process and response tokens count toward `max_tokens`. If `stop_reason` is
> `max_tokens`, Claude may have been thinking when the limit was reached."

Thinking counts toward `max_tokens` **even when the thinking content is not returned to you** —
`display` defaults to `"omitted"` on Fable 5/5.1, Mythos 5/5.1, Opus 5/4.8/4.7 and Sonnet 5, which
means an invisible, billed, budget-consuming reasoning pass. A `max_tokens` sized for a
thinking-disabled model will cut replies off. For agentic work with adaptive thinking, size
`max_tokens` generously and stream.

### 5.4 `refusal`

`response.stop_details` is populated **only** when `stop_reason == "refusal"`; it is `null` for
every other stop reason, so guard before reading. Fields: `type: "refusal"`, `category` (an open
set), `explanation`. The documented remedy is a fallback model, either via the server-side
`fallbacks` parameter or a client-side retry. See §9 — I could not confirm the category list.

### 5.5 Empty responses and the `tool_result` discipline

> "**Never add text blocks immediately after `tool_result` blocks** — this teaches Claude to expect
> user input after every tool use, causing empty responses [with `end_turn`]."

Continuation messages should contain **only** `tool_result` blocks. If you need to add an
instruction, put it in a separate new user message (or, on supporting models, a mid-conversation
system message with `clear_at: "next_user_message"`).

### 5.6 Mapping to P7 (retry at the right layer)

| Failure | Right layer | Safe to replay the loop? |
|---|---|---|
| `max_tokens` before any tool call | Same request, higher `max_tokens` | Yes |
| `max_tokens` with a trailing `tool_use` | Same request, higher `max_tokens` | Yes — the call never executed |
| `max_tokens` *after* a write executed | **Do not replay.** Resume from persisted state | **No** |
| `model_context_window_exceeded` | Compact / restart the loop with fresh context | No — rebuild, don't replay |
| `pause_turn` | Append `response.content` verbatim, same tools, continue | Yes — this is the designed continuation |
| `refusal` | Fallback model or abort to notify-Ben | Yes if no write occurred |
| HTTP 429 / 5xx / connection | Transport layer (SDK `max_retries`, default 2) | Only if the request was not accepted |
| HTTP 400 (e.g. forced `tool_choice` on an unsupported model) | **Config bug — fail loudly.** Never retry | No |

Note that SDK timeouts are themselves retried, so worst-case wall-clock is
`timeout × (max_retries + 1)` — relevant for a lineup-lock deadline.

---

## 6. Agent design patterns

Sources:
- <https://www.anthropic.com/engineering/building-effective-agents>
- <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices> (§ Agentic systems)
- <https://code.claude.com/docs/en/agent-sdk/subagents>

### 6.1 Workflows vs agents

> **Workflows**: "LLMs and tools orchestrated through predefined code paths."
> **Agents**: systems where "LLMs dynamically direct their own processes and tool usage."

Agents buy flexibility at the cost of money, latency and oversight burden. Anthropic's four
criteria before you build one at all: **complexity** (multi-step, hard to fully specify in
advance), **value** (does the outcome justify cost and latency), **viability** (is the model
capable at this task type), **cost of error** (can errors be caught and recovered — tests, review,
rollback).

**Reading for this project:** the GM orchestrator plus five specialists is an *orchestrator-workers*
shape, but most individual jobs (set today's lineup; evaluate this waiver) are **workflows** —
code computes candidates, the model picks, code executes. That matches P1 exactly and is the
cheaper, more auditable tier. Resist promoting them to open-ended agents.

### 6.2 The pattern catalogue

| Pattern | Use when |
|---|---|
| **Prompt chaining** | Task decomposes into fixed sequential steps with programmatic checks between them. Trades latency for accuracy |
| **Routing** | Inputs fall into distinct categories that benefit from separately optimised handlers |
| **Parallelization** | *Sectioning* (independent subtasks) or *voting* (multiple attempts for confidence) |
| **Orchestrator-workers** | A central LLM dynamically decomposes into subtasks delegated to workers. Best where the subtask structure is **unpredictable** |
| **Evaluator-optimizer** | Clear evaluation criteria exist and iteration demonstrably improves the output |
| **Autonomous agents** | Open-ended problems requiring many unpredictable steps |

Note the orchestrator-workers criterion: *unpredictable* structure. A daily lineup job has a
predictable structure; a "should I trade for X" investigation does not.

**Voting** is directly applicable to the project's confirmation-gate policy (≥5 runs, consistency
threshold 1.0) — that *is* the voting pattern used as a gate.

### 6.3 Agent-computer interface (ACI)

Anthropic's headline claim: invest as much effort in the ACI as you would in a human-computer
interface. Concretely:

- Allocate tokens for model reasoning **before** execution.
- Match formats to naturally-occurring internet text.
- Eliminate formatting overhead.
- Include comprehensive documentation with examples and edge cases.
- Test extensively through iteration.
- Apply **poka-yoke** (mistake-proofing) principles — design the tool so misuse is impossible.

> "The SWE-bench agent required more tool optimization than overall prompt refinement."

*Poka-yoke is precisely rule 3 in §0:* the `enum` of legal playerKeys makes a hallucinated key
undrawable rather than merely detectable.

### 6.4 Context management for long loops

From the context-engineering essay — "find the smallest possible set of high-signal tokens that
maximize desired outcomes":

- **System-prompt altitude.** Avoid both extremes: hardcoded brittle if-else logic, and vague
  guidance that assumes shared context. Structure with XML tags or Markdown headers (background,
  instructions, tool guidance, output spec). Aim for "the minimal set of information that fully
  outlines your expected behavior" — but minimal ≠ sparse. Start minimal on a capable model, then
  add examples and clarifications **based on observed failures**.
- **Just-in-time retrieval.** Prefer lightweight identifiers (paths, URLs, stored queries) plus
  runtime tool access over pre-loading everything. Enables progressive disclosure; metadata
  (naming conventions, timestamps) is itself signal. Hybrid strategies — some data up front for
  speed, exploration available — work well.
- **Compaction.** Summarise history near the limit, preserving decisions and critical details
  while discarding redundant tool outputs. "Start by maximizing recall, then iterate toward
  precision." Tool-result clearing is the lightest-touch form.
- **Structured note-taking.** Persist memory outside the context window (notes, to-do lists),
  retrieve when needed.
- **Sub-agent architectures.** Specialised sub-agents with clean context windows return condensed
  summaries — "typically 1,000–2,000 tokens" — to the coordinator.

From the best-practices page's *Agentic systems* section:
- Use **structured formats (JSON) for state data**, freeform text for progress notes, git for
  checkpointing.
- Emphasise incremental progress explicitly.
- "Claude's latest models are extremely effective at discovering state from the local filesystem"
  — sometimes a fresh context window beats compaction.

### 6.5 Scoping an agent's tool allow-list

The Agent SDK is the clearest documented statement of the principle, and it maps 1:1 onto
FantasyHockeyAI's "agents only get `read` and `propose` tools":

> "**Tool restrictions**: subagents can be limited to specific tools, reducing the risk of
> unintended actions. A `doc-reviewer` subagent might only have access to Read and Grep tools,
> ensuring it can analyze but never accidentally modify your documentation files."
>
> "A tool you leave out isn't in the subagent's session at all: Claude works without it, with no
> permission prompt or error."

That last sentence is the design rule worth stealing: **absence, not refusal.** An agent that
cannot see a write tool never has to be told not to use it — which is exactly P2 ("a prompt
instruction is never the gate"). Don't define a `execute_waiver_claim` tool and instruct the model
not to call it; don't define it at all.

Also documented, and relevant to a multi-agent design:

- Subagents get their own system prompt and **only** the Agent-tool prompt string from the parent —
  no parent conversation history. So everything a specialist needs must be in its own prompt.
- Deterministic caps beat prompt instructions: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3),
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), `max_budget_usd`. "Either instruction only
  steers Claude, so set the limits as well."

### 6.6 Autonomy and safety (irreversible actions)

Anthropic's own sample prompt for gating risky actions — useful as *defence in depth* behind P2's
code gate, never as the gate:

```
Consider the reversibility and potential impact of your actions. You are encouraged to
take local, reversible actions like editing files or running tests, but for actions that
are hard to reverse, affect shared systems, or could be destructive, ask the user before
proceeding.
...
When encountering obstacles, do not use destructive actions as a shortcut.
```

### 6.7 Model-specific agentic tuning (Claude Opus 5)

From <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5>,
the items most likely to bite an existing prompt set:

- **Remove verification instructions.** "If your prompt contains explicit verification instructions
  ('include a final verification step for any non-trivial task', 'use a subagent to verify'),
  remove them: instructions like these cause over-verification on Claude Opus 5, and removing them
  reduces wasted tokens with no loss in quality."
- **Remove re-check instructions.** "Avoid instructing re-checks it already performs ('double-check
  your answer', 're-verify before responding')."
- **Constrain scope explicitly** for narrow tasks:
  ```
  Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check
  in only when different readings of the request would lead to materially different work. ...
  Finish the whole task, and stop short of actions that are clearly beyond what was asked.
  ```
- **Watch the literal-instruction-following trap in review-shaped prompts:** "If your review prompt
  says 'only report high-severity issues' or 'be conservative,' the model may follow that
  instruction literally and report less; ask it to report everything and filter in a separate
  pass instead." *This directly applies to WaiverScout and TradeAnalyst: ask for all candidates
  with scores, filter in code.*
- **Cap subagent delegation** — Opus 5 delegates more readily than prior models.
- **Don't disable thinking.** With `thinking: {type:"disabled"}` the model "occasionally writes a
  tool call into its user-facing text instead of emitting a structured `tool_use` block. The turn
  completes normally and the call never runs" — a silent no-op that pollutes later turns. It can
  also leak `<thinking>` tags. Anthropic's guidance: keep thinking on and lower `effort` instead —
  "for most tasks, thinking enabled at `low` effort performs better than thinking disabled at
  similar cost". Disabling thinking is also a 400 at `xhigh`/`max` effort on Opus 5.

---

## 7. Evaluating and iterating on prompts

Source: <https://platform.claude.com/docs/en/test-and-evaluate/develop-tests>

### 7.1 Success criteria: SMART

Specific · Measurable · Achievable · Relevant. Quantify the hazy ones — not "safe outputs" but
"less than 0.1% of outputs flagged for toxicity by content filter". Most applications need
**multidimensional** evaluation (task fidelity, consistency, relevance/coherence, tone,
privacy, context utilisation, latency, price).

### 7.2 Three eval design principles

1. **Be task-specific** — mirror the real-world task distribution, including edge cases.
2. **Automate when possible** — structure questions for automated grading.
3. **Prioritize volume over quality** — "More questions with slightly lower-signal automated
   grading beats fewer high-quality hand-graded evals."

Point 3 is a genuine tension with the project's scenario-eval design (real agents + recorded
fixtures is expensive per case). The reconciliation is the project's own two-tier split:
`eval:smoke` cheap-and-broad on every PR, scenario evals deep-and-narrow.

### 7.3 Grading methods

| Method | Best for |
|---|---|
| Exact match | Categorical answers, classification |
| Cosine similarity over embeddings | Consistency across paraphrases |
| ROUGE-L / BLEU | Summarisation, translation |
| **LLM judge, Likert 1–5** | Subjective qualities: tone, coherence, empathy |
| **LLM judge, binary** | Safety / privacy / factuality checks |
| LLM judge, ordinal | Context utilisation, multi-turn |

### 7.4 LLM-judge prompt best practices

1. Provide a **clear rubric inside the prompt**.
2. Include context about what's being evaluated.
3. Use **consistent scale definitions with anchors** (1–5 with a sentence per level).
4. **Specify output format** — "Output only the number."
5. **Use a separate model for grading** than for generation.
6. Define edge cases explicitly in the evaluation logic.

Anthropic's own shape:

```
Rate this response on coherence (1-5):
1: Nonsensical, incoherent
2: Somewhat confusing, multiple issues
3: Generally coherent with minor issues
4: Clear and well-structured
5: Perfectly logical and organized
```

**For FantasyHockeyAI:** a lineup or waiver decision is closer to *binary* ("is every playerKey in
the emitted lineup eligible and on the roster?" — which should be a code check, not a judge) than
to Likert. Reserve the LLM judge for the *rationale* quality, and grade the *decision* in code.
That's the cheapest correct split and it keeps the judge off the critical path.

### 7.5 Measuring consistency across runs

Documented method: run the same prompt N times (or across N paraphrases), embed the outputs,
compute mean pairwise cosine similarity, set a threshold (example given: > 0.8).

The project's confirmation-gate rule (≥5 runs at threshold 1.0) is a stricter, discrete variant —
exact agreement on the structured decision rather than semantic similarity on prose. That is the
right adaptation for a schema-constrained output: with `strict: true` the decision space is
discrete and exact-match consistency is meaningful. **Worth noting in the spec that 1.0 is
achievable only because the output is enum-constrained**; on free-form text it would be
unattainable and the cosine-similarity method would be the correct instrument.

Anthropic also lists **best-of-N verification** as an anti-hallucination technique in its own
right: "Run Claude through the same prompt multiple times and compare the outputs. Inconsistencies
across outputs could indicate hallucinations."

### 7.6 Edge cases to include

Typos and misspellings; ambiguous inputs; long rambling text; irrelevant information; sarcasm and
implicit meaning; multi-topic content; contradictory statements.

Domain translations for this project: a player on two eligible positions; a player claimed by
another manager between fetch and execute; an empty slate (no games); a stale cache; an NHL API
field that changed shape; a goalie confirmed-starter flag flipping after the proposal.

### 7.7 Prompt versioning — what I found and what I didn't

**I found no current Anthropic documentation page prescribing a prompt-versioning practice.** What
exists is tooling, announced in product news rather than docs:

- **Shareable prompts** in the Console: "Previously, teams resorted to copying and pasting prompts
  between documents or chat applications, leading to version control issues and knowledge silos.
  Shareable prompts in the Anthropic Console now provide a centralized way to develop, refine, and
  standardize prompts across your organization."
  — <https://www.anthropic.com/news/upgraded-anthropic-console>
- **Prompt generator / improver / evaluator** in the Console — automatic test-case generation and
  side-by-side output comparison.
  — <https://www.anthropic.com/news/evaluate-prompts>, <https://www.anthropic.com/news/prompt-improver>
- **The prompt improver is partly stale:** its documented method #5 is "Prefill addition: Prefills
  the Assistant message to direct Claude's actions and enforce output formats" — which is a 400
  error on every current model (§1.8). Treat its output as needing a migration pass.

The project's existing choice — prompts in version-controlled YAML with strict interpolation —
is *more* rigorous than anything Anthropic documents, and nothing I found contradicts it.

---

## 8. Reducing hallucinated identifiers, and getting the model to abstain

Source: <https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations>

### 8.1 Basic strategies (Anthropic's order)

1. **Allow Claude to say "I don't know."**
   > "Explicitly give Claude permission to admit uncertainty. This simple technique can
   > drastically reduce false information."

   Their example ending: `If you're unsure about any aspect or if the report lacks necessary
   information, say "I don't have enough information to confidently assess this."`

2. **Use direct quotes for factual grounding** (documents > 20k tokens): extract word-for-word
   quotes *first*, then do the task. Their example: `If you can't find relevant quotes, state "No
   relevant quotes found."` … `Only base your analysis on the extracted quotes.`

3. **Verify with citations.** Have Claude cite a supporting quote for each claim, and — this is
   the strong form — **retract unsupported claims**:
   > "After drafting, review each claim in your press release. For each claim, find a direct quote
   > from the documents that supports it. If you can't find a supporting quote for a claim, remove
   > that claim from the press release and mark where it was removed with empty [] brackets."

### 8.2 Advanced techniques

- **Chain-of-thought verification** — explain reasoning step by step before the final answer.
- **Best-of-N verification** — same prompt N times, compare; inconsistency signals hallucination.
- **Iterative refinement** — feed outputs back as inputs for verification/expansion.
- **External knowledge restriction** — "Explicitly instruct Claude to only use information from
  provided documents and not its general knowledge."

Anthropic's own caveat, which belongs in the project spec:
> "Remember, while these techniques significantly reduce hallucinations, they don't eliminate them
> entirely. Always validate critical information, especially for high-stakes decisions."

That sentence is the documentary justification for P3. Prompting reduces the rate; only the index
resolution makes it safe.

### 8.3 The agentic-coding variant (grounding before asserting)

From the best-practices page, adapted almost verbatim to this domain:

```
<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file,
you MUST read the file before answering. Make sure to investigate and read relevant
files BEFORE answering questions about the codebase. Never make any claims about code
before investigating unless you are certain of the correct answer - give grounded and
hallucination-free answers.
</investigate_before_answering>
```

FantasyHockeyAI translation:

```
<investigate_before_proposing>
Never assert a player's team, position, injury status or availability from memory. Every
such fact must come from a tool result in this conversation. If a tool has not returned
the fact you need, call the tool; if no tool can return it, call propose_no_action with
the missing fact named in `reason`. Every playerKey you emit must appear verbatim in a
tool result above — never construct, complete or recall one.
</investigate_before_proposing>
```

### 8.4 Layering the defences for P3 and P5

Ordered from strongest to weakest. Anthropic documents all four; only the first is a *guarantee*.

| Layer | Mechanism | Guarantee |
|---|---|---|
| 1. Schema `enum` + `strict: true` | Grammar-constrained sampling cannot produce an out-of-enum token | **Hard.** Fabrication is undrawable |
| 2. Index resolution in code (P3) | Reject any key not in the league index | **Hard**, but post-hoc: costs a retry |
| 3. Tool-response design | Return `name (TEAM, POS) [key]` rows so the model reasons over names and copies keys; return only high-signal fields | Soft |
| 4. Prompt instruction | "Only use playerKeys returned by tools", "never recall from memory" | Soft. Rate reduction only |

**Abstention as a first-class output.** Anthropic's *Running with thinking disabled* section gives
the canonical phrasing for the "no tool fits" case: `If no tool can express what the user asked
for, say so instead of guessing.` Under `tool_choice: auto` the model can simply not call a tool.
Under forced `any` it **must** call something — which is an argument, independent of the 400-error
issue in §2.3, for exposing an explicit `propose_no_action { reason }` tool rather than forcing a
substantive proposal. With the abstain tool in the allow-list, "do nothing and notify Ben" is a
structured, loggable decision (P10) rather than an error path.

**On uncertainty calibration generally:** the model cards note the standing tradeoff — "models that
frequently say they don't know the answer will make fewer mistakes but also tend to give an unsure
response in some borderline cases where they would have answered correctly"
(<https://www-cdn.anthropic.com/de8ba9b01c9ab7cbabf5c33b80b7bbc618857627/Model_Card_Claude_3.pdf>).
For irreversible fantasy actions that tradeoff is clearly worth taking; measure the abstain rate
in the evals so you notice if it drifts high enough to make the system useless.

**Input hallucination** — a distinct failure mode named in the Mythos Preview system card — is
Claude "claiming it has access to tools or affordances (like web search or file system access)
that were not actually provided", or inventing missing context rather than asking for it. The
documented honest behaviour: "an honest model should decline to complete the task and note that it
does not have the requisite tools rather than fabricating output" and "should ask for and
acknowledge the missing context rather than invent it". Worth an eval scenario: hand an agent a
prompt whose `{{roster}}` block is empty and assert it abstains rather than inventing a roster.
This is also the second argument for treating an unrendered `{{var}}` as a hard error.

---

## 9. Contradictions and uncertainties

Things I could **not** confirm, or where sources disagree. These are stated as gaps, not guesses.

1. **`stop_details.category` values — CONFLICT, unresolved.** One summarisation of the stop-reasons
   page reported the categories as `"sexual_content"`, `"violence"`, `"illegal_activity"`. A
   separate, independent source (the bundled `claude-api` skill reference) gives the open set as
   `"cyber"`, `"bio"`, `"reasoning_extraction"`, `"frontier_llm"`, or `null`. These are
   incompatible, and the first list has the flavour of a summariser's invention. **I did not verify
   either against the raw page.** Do not hardcode category strings; treat `category` as an open
   string set, log it, and branch only on `stop_reason == "refusal"`.

2. **Per-model minimum cacheable prefix (§4.3) is summariser-derived.** The 512/1024/2048/4096
   tiering is consistent across two independent sources, but the exact model→tier assignments came
   from a page summarisation rather than a verbatim table read. Re-read the live table before
   sizing a cached prefix within ~20% of a boundary.

3. **The "20 block lookback window" (§4.4)** appeared only in a page summarisation. I did not see it
   quoted verbatim. Treat as probable but unconfirmed.

4. **Structured-outputs supported-model list.** Two fetches of the same page returned slightly
   different model lists (one included Opus 5.5 and Mythos 5.1, one did not) — almost certainly a
   snapshot/caching artefact of the doc site rather than a real disagreement, but it means the list
   in §3.3 should be re-read at implementation time rather than trusted as frozen.

5. **Whether `strict: true` is supported on *every* model that supports structured outputs, or a
   subset.** The docs treat strict tool use and JSON outputs as two features of one system with one
   compatibility table, which implies a shared model list. I did not find an explicit statement
   that the lists are identical. Verify before relying on `strict` on a specific model.

6. **No current ranked ordering of prompting techniques exists.** §1.1. If the project's skill wants
   a priority order, it will be the skill author's synthesis, not Anthropic's position, and should
   say so.

7. **No documented prompt-versioning practice.** §7.7. Console "shareable prompts" is a
   collaboration feature, not a versioning discipline, and the docs say nothing about
   version-pinning prompts against model versions.

8. **Whether an unsupported JSON Schema keyword under `strict: true` errors or is silently dropped.**
   The docs say the *SDK* transformation "automatically handles unsupported constraints by updating
   descriptions and validating responses locally". What the raw API does with, say, a `maximum`
   keyword sent directly is not stated. If the project builds JSON Schema from zod by hand rather
   than via the SDK helper, test this.

9. **Model the project actually targets.** The forced-tool-use 400 (§2.3) applies to Opus 5.5,
   Fable 5.1 and Mythos 5.1 — **not** to Opus 5, Sonnet 5 or Opus 4.8. I do not know which model
   FantasyHockeyAI's agents run on. If they run on Opus 5 or Sonnet 5 today, **P4's forced tool
   calls still work** and nothing is broken right now; the finding is a forward-compatibility
   liability, not a live bug. If they run on Opus 5.5 or Fable 5.1, forced tool calls are already
   failing with a 400. Check before acting on rule 1 in §0.

10. **Whether `output_config.format` can be used in the same request as `tools` with `tool_choice`
    forcing.** Docs confirm JSON outputs + `strict: true` tools combine; I found no statement about
    JSON outputs + a *forced* tool call, and the combination is conceptually odd (the forced call
    is the output). Untested.

11. **Effect of `strict: true` on latency in a per-day-run system.** Grammar compilation costs extra
    latency on the *first* request with a given schema, and compiled grammars cache for 24h. A
    system that runs once per day, on a fixed schema, will plausibly pay compilation on **every**
    run (24h TTL vs ~24h cadence). I could not confirm whether the TTL is "24 hours since last use"
    sliding (which the strict-tool-use page's wording — "temporarily cached for up to 24 hours since
    last use" — suggests) in a way that a daily cadence would keep warm. Measure it.

12. **Anthropic's Console prompt improver still recommends prefill** (§7.7), which is a 400 on all
    current models. This is a real, live contradiction inside Anthropic's own surfaces. Docs win.

---

## 10. Sources

All retrieved **2026-09-24**.

| # | URL | Used for |
|---|---|---|
| 1 | <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview> | §1.1 — the page is now a stub pointing at #2 |
| 2 | <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices> | §1.2–1.10, §2.4, §2.6, §6.4, §8.3 — the living prompting reference |
| 3 | <https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5> | §6.7 — Opus 5 specific tuning, thinking-disabled failure modes |
| 4 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview> | §2.3, §2.5 — tool_choice steering, missing params, token table |
| 5 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools> | §2.1, §2.3 — tool-definition best practices, forced-tool-use restriction table, `input_examples` |
| 6 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use> | §3.1, §3.6 — `strict: true` guarantees, grammar caching, data retention |
| 7 | <https://platform.claude.com/docs/en/build-with-claude/structured-outputs> | §3 — `output_config.format`, schema limitations, feature compatibility |
| 8 | <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> | §4 — breakpoints, minimums, TTL, pricing, invalidation |
| 9 | <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons> | §5 — full stop_reason set, truncation, pause_turn, tool_result discipline |
| 10 | <https://platform.claude.com/docs/en/api/handling-stop-reasons> | §5 — corroborating stop-reason reference |
| 11 | <https://platform.claude.com/docs/en/release-notes/api> | §3.2, §4.4 — dated changelog for structured outputs, tool_choice 400s, effort, cache TTL |
| 12 | <https://platform.claude.com/docs/en/test-and-evaluate/develop-tests> | §7 — success criteria, grading methods, LLM judge, consistency |
| 13 | <https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations> | §8.1–8.2 — abstention, quote grounding, citations, best-of-N |
| 14 | <https://www.anthropic.com/engineering/building-effective-agents> | §6.1–6.3 — workflow vs agent, pattern catalogue, ACI/poka-yoke |
| 15 | <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> | §6.4 — system-prompt altitude, just-in-time retrieval, compaction, sub-agents |
| 16 | <https://www.anthropic.com/engineering/writing-tools-for-agents> | §2.2 — tool consolidation, semantic identifiers, error messages, tool evals |
| 17 | <https://code.claude.com/docs/en/agent-sdk/subagents> | §6.5 — tool allow-lists, context isolation, deterministic caps |
| 18 | <https://www.anthropic.com/news/upgraded-anthropic-console> | §7.7 — shareable prompts |
| 19 | <https://www.anthropic.com/news/evaluate-prompts> | §7.7 — Console eval tooling |
| 20 | <https://www.anthropic.com/news/prompt-improver> | §7.7 — prompt improver methods (incl. the stale prefill recommendation) |
| 21 | <https://www-cdn.anthropic.com/8b8380204f74670be75e81c820ca8dda846ab289.pdf> (Claude Mythos Preview System Card) | §8.4 — factual vs input hallucination taxonomy |
| 22 | <https://www-cdn.anthropic.com/de8ba9b01c9ab7cbabf5c33b80b7bbc618857627/Model_Card_Claude_3.pdf> | §8.4 — the IDK / accuracy calibration tradeoff |

**Non-web source used and labelled as such:** the `claude-api` skill bundled with this Claude Code
installation (`shared/*.md` reference tables, cached 2026-06-24) corroborated §2.3, §4, §5.2 and
§5.3 and supplied the conflicting `stop_details.category` list noted in §9.1. It is a
first-party reference but not a citable public URL; where it is the *only* source for a claim,
that claim is in §9 rather than in the body.
