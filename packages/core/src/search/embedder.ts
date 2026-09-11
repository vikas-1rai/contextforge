import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as ort from 'onnxruntime-node';

/**
 * Local text embedder using all-MiniLM-L6-v2 via onnxruntime-node directly.
 * Converts text strings to 384-dimensional float32 vectors.
 * Runs entirely in-process — no external API needed.
 *
 * Model resolution order:
 * 1. Bundled with the server binary/extension (sibling models/ directory)
 * 2. Local cache at ~/.contextforge/models/
 *
 * If no model found, vector search is disabled gracefully.
 */

interface TokenizerVocab { [token: string]: number }

export class Embedder {
  private session: ort.InferenceSession | null = null;
  private vocab: TokenizerVocab = {};
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;

  private readonly CLS_ID = 101;
  private readonly SEP_ID = 102;
  private readonly PAD_ID = 0;
  private readonly UNK_ID = 100;
  private readonly MAX_LENGTH = 128;

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  /**
   * Resolve the model directory — check an explicit override, then locations
   * bundled with the binary/script, then the user cache.
   */
  private resolveModelDir(): string | null {
    const modelSubpath = path.join('Xenova', 'all-MiniLM-L6-v2');
    const hasModel = (dir: string) => fs.existsSync(path.join(dir, 'onnx', 'model.onnx'));

    // 0. Explicit override (internal deployments can pin the model location).
    const envDir = process.env.CONTEXTFORGE_MODEL_DIR;
    if (envDir) {
      // Allow pointing either at the model dir itself or its parent models/ dir.
      const candidates = [envDir, path.join(envDir, modelSubpath)];
      for (const dir of candidates) {
        if (hasModel(dir)) {
          process.stderr.write(`[embedder] Using model from CONTEXTFORGE_MODEL_DIR at ${dir}\n`);
          return dir;
        }
      }
    }

    // 1. Check bundled alongside the running script/binary (e.g. extension's server/models/)
    const bundledDir = path.join(__dirname, '..', 'models', modelSubpath);
    if (hasModel(bundledDir)) {
      process.stderr.write(`[embedder] Found bundled model at ${bundledDir}\n`);
      return bundledDir;
    }

    // 2. Check next to the packaged executable (release/contextforge + release/models/).
    //    __dirname is virtualized inside a pkg snapshot, so use process.execPath.
    try {
      const execSiblingDir = path.join(path.dirname(process.execPath), 'models', modelSubpath);
      if (hasModel(execSiblingDir)) {
        process.stderr.write(`[embedder] Found model beside executable at ${execSiblingDir}\n`);
        return execSiblingDir;
      }
    } catch {
      // process.execPath is always defined in practice; ignore any lookup failure.
    }

    // 3. Check user cache at ~/.contextforge/models/
    const userCacheDir = path.join(os.homedir(), '.contextforge', 'models', modelSubpath);
    if (hasModel(userCacheDir)) {
      process.stderr.write(`[embedder] Found model in user cache at ${userCacheDir}\n`);
      return userCacheDir;
    }

    return null;
  }

  private async doInit(): Promise<boolean> {
    try {
      const modelDir = this.resolveModelDir();
      if (!modelDir) {
        process.stderr.write('[embedder] No model found. Vector search disabled.\n');
        process.stderr.write('[embedder] To enable: place model at ~/.contextforge/models/Xenova/all-MiniLM-L6-v2/\n');
        process.stderr.write('[embedder] or set CONTEXTFORGE_MODEL_DIR to the model directory.\n');
        this.initialized = false;
        return false;
      }

      // Load vocab from tokenizer.json
      const tokenizerPath = path.join(modelDir, 'tokenizer.json');
      const tokenizer = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8'));
      this.vocab = tokenizer.model.vocab;

      // Load ONNX model
      const modelPath = path.join(modelDir, 'onnx', 'model.onnx');
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
      });

      this.initialized = true;
      process.stderr.write('[embedder] Model loaded successfully. Vector search enabled.\n');
      return true;
    } catch (err) {
      process.stderr.write(`[embedder] Failed to load model: ${err}. Vector search disabled.\n`);
      this.initialized = false;
      return false;
    }
  }

  get available(): boolean {
    return this.initialized;
  }

  /**
   * WordPiece tokenization matching BERT tokenizer behavior.
   */
  private tokenize(text: string): number[] {
    // Basic normalization: lowercase, strip accents, clean whitespace
    text = text.toLowerCase().replace(/[\u0300-\u036f]/g, '').trim();

    // Split on whitespace and punctuation (BertPreTokenizer behavior)
    const words = text.match(/[a-z0-9]+|[^\s\w]/g) || [];

    const tokens: number[] = [];
    for (const word of words) {
      let remaining = word;
      let isFirst = true;

      while (remaining.length > 0) {
        let found = false;
        for (let end = remaining.length; end > 0; end--) {
          const substr = isFirst ? remaining.slice(0, end) : '##' + remaining.slice(0, end);
          if (substr in this.vocab) {
            tokens.push(this.vocab[substr]);
            remaining = remaining.slice(isFirst ? end : end);
            isFirst = false;
            found = true;
            break;
          }
        }
        if (!found) {
          tokens.push(this.UNK_ID);
          break;
        }
      }
    }

    return tokens;
  }

  /**
   * Generate a 384-dimensional embedding for the given text.
   * Returns null if the embedder is not available.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.session) return null;

    try {
      // Tokenize with [CLS] ... [SEP] + padding to MAX_LENGTH
      const wordTokens = this.tokenize(text);
      const maxTokens = this.MAX_LENGTH - 2; // reserve for CLS and SEP
      const truncated = wordTokens.slice(0, maxTokens);

      const inputIds = new Array(this.MAX_LENGTH).fill(this.PAD_ID);
      const attentionMask = new Array(this.MAX_LENGTH).fill(0);
      const tokenTypeIds = new Array(this.MAX_LENGTH).fill(0);

      inputIds[0] = this.CLS_ID;
      attentionMask[0] = 1;
      for (let i = 0; i < truncated.length; i++) {
        inputIds[i + 1] = truncated[i];
        attentionMask[i + 1] = 1;
      }
      inputIds[truncated.length + 1] = this.SEP_ID;
      attentionMask[truncated.length + 1] = 1;

      // Run inference
      const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [1, this.MAX_LENGTH]);
      const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, this.MAX_LENGTH]);
      const tokenTypeIdsTensor = new ort.Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)), [1, this.MAX_LENGTH]);

      const results = await this.session.run({
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
        token_type_ids: tokenTypeIdsTensor,
      });

      // Get last_hidden_state: shape [1, MAX_LENGTH, 384]
      const output = results['last_hidden_state'] || results[Object.keys(results)[0]];
      const data = output.data as Float32Array;
      const hiddenSize = 384;

      // Mean pooling over non-padded tokens
      const seqLen = truncated.length + 2; // CLS + tokens + SEP
      const pooled = new Float32Array(hiddenSize);
      for (let i = 0; i < seqLen; i++) {
        for (let j = 0; j < hiddenSize; j++) {
          pooled[j] += data[i * hiddenSize + j];
        }
      }
      for (let j = 0; j < hiddenSize; j++) {
        pooled[j] /= seqLen;
      }

      // L2 normalize
      let norm = 0;
      for (let j = 0; j < hiddenSize; j++) {
        norm += pooled[j] * pooled[j];
      }
      norm = Math.sqrt(norm);
      for (let j = 0; j < hiddenSize; j++) {
        pooled[j] /= norm;
      }

      return pooled;
    } catch (err) {
      process.stderr.write(`[embedder] Embedding failed: ${err}\n`);
      return null;
    }
  }

  /**
   * Serialize a Float32Array to a Buffer for storage in sqlite-vec.
   */
  static toBlob(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Deserialize a Buffer back to Float32Array.
   */
  static fromBlob(blob: Buffer): Float32Array {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }

  /**
   * Cosine similarity between two vectors. Embeddings produced by embed() are
   * already L2-normalized, so this reduces to a dot product, but we normalize
   * defensively in case one side is not normalized.
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
