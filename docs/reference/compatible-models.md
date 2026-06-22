# Compatible Models Reference — Nodedex Auto-Reflect

## Pipeline requirements

Every stage of the v2 pipeline needs **structured-JSON output** — and the provider layer picks
tool-use / `response_format` / a prompt-JSON fallback per model, so any reasonably capable model
works. Beyond that:

| Need | Where it matters | Notes |
|---|---|---|
| Structured JSON | all stages | hard requirement (the provider layer handles the mechanism) |
| Real reasoning | comprehension · the worth-gate · relation/chain wiring | a model that actually *thinks* produces deeper links — the most reasoning-intensive work |
| Cheap/fast is fine | the mechanical `unique{}` fill | no reasoning needed |
| Context | all | modest — one turn, ~4–16K in |

A small local model will *run* (via the prompt-JSON fallback) but tends to produce shallow links on
the reasoning stages — use a capable model there if quality matters.

---

## Model routing

**Default: one model runs everything** — `AI_MODEL` / `NODEDEX_PRIMARY_MODEL`, plus an optional
`NODEDEX_FALLBACK_MODEL` the provider escalates to on a hard failure / 429 / timeout. You do **not**
have to route per stage.

For people who want a strong model on the hard work and a cheap one on the mechanical fill, two
tier vars + per-stage overrides exist (resolution: per-stage override → tier → default):

| Variable | For |
|---|---|
| `NODEDEX_REASONING_MODEL` | the reasoning stages — typing, dedup, causal wiring, naming, cross-session links |
| `NODEDEX_STRUCTURAL_MODEL` | the mechanical stage — `unique{}` fill |
| `NODEDEX_PASS{N}_MODEL` | pin one specific stage (highest priority; e.g. `NODEDEX_PASS4_MODEL` for relation-wiring) |

```
NODEDEX_REASONING_MODEL=deepseek/deepseek-reasoner    # strong model where reasoning matters
NODEDEX_STRUCTURAL_MODEL=anthropic/claude-haiku-4.5   # cheap model on the mechanical fill
```
Set nothing → every stage uses your default. Use the model-name form your provider expects
(OpenRouter prefixes like `anthropic/claude-haiku-4.5`).

---

## Model Compatibility

### Gemini (Google AI Studio / Vertex AI)

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `gemini-2.5-pro` | ✓ native | ✓ reliable | 1M | **Best overall.** Always thinks when budgeted. Ideal for Pass 4. |
| `gemini-2.5-flash` | ✓ native | ✗ unreliable | 1M | Good for the lighter stages; skips thinking on structured tasks, so not ideal for the reasoning-heavy relation/chain wiring. |
| `gemini-2.0-flash` | ✓ native | ✗ | 1M | No thinking. Works for the lighter stages but older generation. |

**Config:**
```
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
GEMINI_API_KEYS=key1,key2,key3        # multi-key rotation
NODEDEX_PRIMARY_MODEL=gemini-2.5-flash
NODEDEX_FALLBACK_MODEL=gemini-2.5-pro
NODEDEX_PASS4_MODEL=gemini-2.5-pro    # Pass 4 always uses Pro by default
```

**Pros:** Native schema enforcement, best thinking quality, 1M context, key rotation built-in.
**Cons:** Free tier rate limits are tight. All 3 keys can exhaust simultaneously on heavy use.

---

### OpenAI

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `gpt-4.1` | ✓ native | ✗ | 1M | Strong schema compliance. No thinking tokens. |
| `gpt-4o` | ✓ native | ✗ | 128K | Solid all-rounder. No thinking. |
| `o4-mini` | ✓ native | ✓ built-in | 128K | Good reasoning, cheaper than Pro. Thinking is implicit (no separate tokens). |
| `gpt-4o-mini` | ✓ native | ✗ | 128K | Cheapest option. Weaker quality on complex passes. |

**Config:**
```
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
AI_MODEL=gpt-4o                       # primary model
NODEDEX_PASS4_MODEL=o4-mini           # use o4-mini for Pass 4 reasoning
```

**Pros:** Reliable schema enforcement, large ecosystem, no rate-limit surprises on paid tier.
**Cons:** No native thinking tokens (o-series thinking is implicit). 128K context limit on most models (except gpt-4.1).

---

### Anthropic (Claude)

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `claude-opus-4-6` | ✓ via tool_use | ✓ extended thinking | 200K | Best reasoning quality. Schema via tool_use (slightly different from native). |
| `claude-sonnet-4-6` | ✓ via tool_use | ✓ | 200K | Good balance of speed and quality. |
| `claude-haiku-4-5` | ✓ via tool_use | ✗ | 200K | Fast, cheap. Weaker on complex Pass 4 reasoning. |

**Config:**
```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key
AI_MODEL=claude-opus-4-6
NODEDEX_PASS4_MODEL=claude-opus-4-6
```

**Pros:** Best long-context reasoning. 200K context reliable. Extended thinking available.
**Cons:** Schema is via tool_use (not native constrained decoding) — occasional schema violations on complex outputs. Higher cost. No embedding provider (falls back to Gemini or OpenAI for embeddings).

---

### DeepSeek (via DeepSeek API or OpenRouter)

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `deepseek-chat` (V3) | ✓ native | ✗ | 64K | Fast, cheap. No thinking. |
| `deepseek-reasoner` (R1/V3.2-thinking) | ✓ native | ✓ 64K tokens | 64K | Excellent reasoning. Thinking in `<think>` blocks — pipeline extracts them. |

**Config (via OpenAI-compatible endpoint):**
```
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_deepseek_key
OPENAI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
NODEDEX_PASS4_MODEL=deepseek-reasoner
```

**Pros:** Very cheap. `deepseek-reasoner` has excellent reasoning quality. OpenAI-compatible API.
**Cons:** 64K context limit (fine for all passes). Thinking tokens are in `<think>` blocks — the pipeline currently reads Gemini-style thinking parts; DeepSeek thinking extraction may need provider-specific handling.

---

### Qwen (Alibaba — via Ollama, Together AI, or OpenRouter)

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `qwen3-32b` | ✓ native | ✓ dual-mode | 32K–1M | Free (open-source). Thinking mode toggleable. Good structured output. |
| `qwen3-235b-a22b` | ✓ native | ✓ | 32K–1M | MoE flagship. Best Qwen for Pass 4. |
| `qwen2.5-72b` | ✓ native | ✗ | 128K | Older generation. No thinking. |

**Config (via Ollama locally):**
```
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=ollama              # Ollama doesn't need a real key
OPENAI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3-32b
NODEDEX_PASS4_MODEL=qwen3-235b-a22b
```

**Config (via Together AI):**
```
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_together_key
OPENAI_BASE_URL=https://api.together.xyz/v1
AI_MODEL=Qwen/Qwen3-32B-Instruct
NODEDEX_PASS4_MODEL=Qwen/Qwen3-235B-A22B-Instruct
```

**Pros:** Free if self-hosted. 1M context. Good thinking quality. Best option for privacy/air-gap setups.
**Cons:** Self-hosting requires significant RAM (72B = ~40GB). Hosted versions have rate limits. Schema compliance slightly less reliable than Gemini native.

---

### Groq (Llama / Qwen — fast inference)

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `llama-3.3-70b-versatile` | ✓ constrained | ✗ | 128K | Fast. No thinking. Constrained decoding guarantees schema. |
| `qwen-qwq-32b` | ✓ | ✓ | 128K | Thinking model on Groq. Good for Pass 4. |

**Config:**
```
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_groq_key
OPENAI_BASE_URL=https://api.groq.com/openai/v1
AI_MODEL=llama-3.3-70b-versatile
NODEDEX_PASS4_MODEL=qwen-qwq-32b
```

**Pros:** Very fast inference. Free tier generous. Constrained decoding guarantees schema compliance.
**Cons:** Rate limits on free tier. Context 128K max. Model selection limited.

---

### Mistral

| Model | Schema | Thinking | Context | Notes |
|---|---|---|---|---|
| `mistral-large-latest` | ✓ native strict | ✗ | 128K | Reliable nested schema compliance. No thinking. |
| `mistral-medium` | ✓ | ✗ | 128K | Cheaper. Adequate for the lighter stages. |

**Config:**
```
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_mistral_key
OPENAI_BASE_URL=https://api.mistral.ai/v1
AI_MODEL=mistral-large-latest
```

**Pros:** `strict: true` schema enforcement. Reliable on nested schemas.
**Cons:** No thinking. Best as a fallback/budget option, not primary.

---

## Pass 4 Model Recommendation by Provider

Pass 4 needs the best reasoning model available. Default recommendation per provider:

| AI_PROVIDER | Recommended NODEDEX_PASS4_MODEL |
|---|---|
| gemini | `gemini-2.5-pro` (default) |
| openai | `o4-mini` |
| anthropic | same as AI_MODEL (already strong) |
| openai-compatible (DeepSeek) | `deepseek-reasoner` |
| openai-compatible (Groq) | `qwen-qwq-32b` |
| openai-compatible (Qwen/Ollama) | `qwen3-235b-a22b` or largest available |
| openai-compatible (Mistral) | same as AI_MODEL (no thinking upgrade available) |

If `NODEDEX_PASS4_MODEL` is not set, Pass 4 uses `AI_MODEL` (same as other passes).

---

## Embeddings

Embeddings are separate from the LLM provider. Options:

| Provider | Model | Notes |
|---|---|---|
| Gemini (default) | `gemini-embedding-001` | Best quality. Requires GEMINI_API_KEY. |
| OpenAI | `text-embedding-3-small` | Good quality. Used when AI_PROVIDER=openai. |
| None | — | Embeddings disabled. Recall still works via keyword search. |

Anthropic has no embedding API — if `AI_PROVIDER=anthropic`, set `GEMINI_API_KEY` or `OPENAI_API_KEY` for embeddings.
