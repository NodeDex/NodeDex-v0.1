import type { EmbeddingProvider } from "../ai-provider.js";

// ─── Local, free, offline embeddings (transformers.js / ONNX) ─────────────────
// Runs an embedding model IN-PROCESS — no API, no quota, no network after the
// one-time model download (cached). The local-first default: works on any
// machine (CPU is plenty for embedding models; a GPU is optional/overkill).
//
// Enable with EMBEDDING_PROVIDER=local. Model via NODEDEX_LOCAL_EMBED_MODEL
// (default bge-small-en-v1.5 — 384-dim, fast, strong on technical text).
//
// NOTE: vectors are model-specific (dim + space). Switching to/from this provider
// requires re-embedding existing blocks (POST /api/admin/reembed-all).
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private extractorP: Promise<any> | null = null;

  constructor(model?: string) {
    this.model = model ?? process.env.NODEDEX_LOCAL_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
  }

  /** Lazy-load the pipeline once (dynamic import so the dep is only pulled when this
   *  provider is actually selected). The first call downloads + caches the model. */
  private getExtractor(): Promise<any> {
    if (!this.extractorP) {
      this.extractorP = (async () => {
        const tf: any = await import("@huggingface/transformers");
        if (tf.env) tf.env.allowRemoteModels = true; // download once, then served from cache
        console.log(`[local-embed] loading model ${this.model} (one-time download on first run)…`);
        const extractor = await tf.pipeline("feature-extraction", this.model);
        console.log(`[local-embed] model ready: ${this.model}`);
        return extractor;
      })();
    }
    return this.extractorP;
  }

  async embed(text: string): Promise<number[] | null> {
    try {
      const extractor = await this.getExtractor();
      const out = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(out.data as Float32Array | number[]);
    } catch (e) {
      console.error("[local-embed] embed failed:", String((e as any)?.message ?? e).slice(0, 200));
      return null;
    }
  }

  isAvailable(): boolean { return true; }
}
