# How to Add or Switch an LLM Provider

**When:** You want to use a different AI provider for the pipeline, or configure separate models for different passes.

---

## Supported Providers

| Provider | Config value | Notes |
|---|---|---|
| Google Gemini | `gemini` | Recommended. Best reasoning quality + 1M context. |
| OpenAI | `openai` | Native schema enforcement. |
| Anthropic Claude | `anthropic` | Best long-context reasoning. No native embeddings. |
| DeepSeek | `openai-compatible` | Cheap, good reasoning. Via OpenAI-compatible API. |
| Groq | `openai-compatible` | Fast inference. Limited model selection. |
| Qwen (Ollama / Together) | `openai-compatible` | Free if self-hosted. Privacy/air-gap setups. |
| Mistral | `openai-compatible` | Reliable schema enforcement. No thinking. |

---

## Minimal Configuration

Set `AI_PROVIDER` and the matching API key in your `.env`:

**Gemini:**
```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
```

**OpenAI:**
```env
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
```

**Anthropic:**
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key
# Anthropic has no embedding API — add Gemini or OpenAI for embeddings:
GEMINI_API_KEY=your_gemini_key
```

**Any OpenAI-compatible API (DeepSeek, Groq, Qwen, Mistral, Ollama):**
```env
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_key
OPENAI_BASE_URL=https://api.deepseek.com/v1   # provider endpoint
AI_MODEL=deepseek-chat                          # primary model
```

---

## Configure Pass-Specific Models

Some passes need more reasoning than others. Pass 4 (relation finding) is the most demanding — it must hold a full batch of blocks in mind and trace narrative chains. You can use a cheaper model for early passes and a stronger one for Pass 4:

```env
AI_MODEL=gemini-2.5-flash          # primary model for Passes 0, 1, 2, 3, 5
NODEDEX_PASS4_MODEL=gemini-2.5-pro  # stronger model for Pass 4
```

If `NODEDEX_PASS4_MODEL` is not set, Pass 4 uses `AI_MODEL`.

**Recommended Pass 4 model per provider:**

| Provider | NODEDEX_PASS4_MODEL |
|---|---|
| gemini | `gemini-2.5-pro` (default) |
| openai | `o4-mini` |
| anthropic | same as AI_MODEL |
| openai-compatible (DeepSeek) | `deepseek-reasoner` |
| openai-compatible (Groq) | `qwen-qwq-32b` |
| openai-compatible (Qwen/Ollama) | `qwen3-235b-a22b` or largest available |
| openai-compatible (Mistral) | same as AI_MODEL |

---

## Multi-Key Rotation (Gemini)

Gemini free tier has tight per-key rate limits. Add multiple keys to prevent exhaustion:

```env
GEMINI_API_KEYS=key1,key2,key3
```

The pipeline rotates through keys automatically. When one is rate-limited, it switches to the next.

---

## Provider-Specific Notes

### Gemini

The primary recommended provider. Native JSON schema enforcement means structured outputs are reliable.

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
GEMINI_API_KEYS=key1,key2,key3    # optional: multi-key rotation
NODEDEX_PRIMARY_MODEL=gemini-2.5-flash
NODEDEX_FALLBACK_MODEL=gemini-2.5-pro
NODEDEX_PASS4_MODEL=gemini-2.5-pro
```

`gemini-2.5-flash` skips thinking on structured tasks — use `gemini-2.5-pro` for Pass 4.

### OpenAI

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your_key
AI_MODEL=gpt-4o
NODEDEX_PASS4_MODEL=o4-mini
```

`o4-mini` has implicit thinking (no separate thinking tokens) and is cheaper than `gpt-4o` for Pass 4 reasoning.

### DeepSeek

```env
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_deepseek_key
OPENAI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
NODEDEX_PASS4_MODEL=deepseek-reasoner
```

`deepseek-reasoner` outputs thinking in `<think>` blocks. The pipeline extracts these.

### Qwen (self-hosted via Ollama)

```env
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3-32b
NODEDEX_PASS4_MODEL=qwen3-235b-a22b
```

`qwen3-235b-a22b` requires significant RAM (~100GB+ for the MoE model). Use `qwen3-32b` for both if you don't have the resources for the larger model.

### Groq

```env
AI_PROVIDER=openai-compatible
OPENAI_API_KEY=your_groq_key
OPENAI_BASE_URL=https://api.groq.com/openai/v1
AI_MODEL=llama-3.3-70b-versatile
NODEDEX_PASS4_MODEL=qwen-qwq-32b
```

Fast inference but limited model selection. Good for development/testing.

---

## Embeddings Configuration

Embeddings are separate from the LLM provider. Without embeddings, semantic search still works via keyword search — but similarity-based recall and `workspace_find_skill` won't work.

| Provider | Auto-configured when |
|---|---|
| Gemini (`gemini-embedding-001`) | `AI_PROVIDER=gemini` |
| OpenAI (`text-embedding-3-small`) | `AI_PROVIDER=openai` |
| None | Any other provider (add a Gemini or OpenAI key for embeddings) |

If using Anthropic, DeepSeek, Groq, or Qwen as your LLM, add an embedding provider:

```env
# Add to enable embeddings with any LLM provider
GEMINI_API_KEY=your_gemini_key   # uses gemini-embedding-001
# OR
OPENAI_API_KEY=your_openai_key  # uses text-embedding-3-small
```

---

## Restart After Config Changes

The server reads `.env` at startup only. After changing environment variables:

```bash
# If using npx nodedex
npx nodedex restart

# If running the server directly
# Kill the process and restart
```

Verify the new provider is active:
```bash
GET /api/health
```

The health endpoint shows which providers are configured and connected.
