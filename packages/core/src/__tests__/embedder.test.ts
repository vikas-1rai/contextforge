import { Embedder } from '../search/embedder';

describe('Embedder', () => {
  let embedder: Embedder;

  beforeAll(() => {
    embedder = new Embedder();
  });

  it('initializes successfully with local model', async () => {
    const ok = await embedder.init();
    expect(ok).toBe(true);
    expect(embedder.available).toBe(true);
  });

  it('produces 384-dimensional embeddings', async () => {
    await embedder.init();
    const vec = await embedder.embed('test embedding');
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(384);
  });

  it('produces normalized vectors (unit length)', async () => {
    await embedder.init();
    const vec = await embedder.embed('hello world');
    expect(vec).not.toBeNull();
    const magnitude = Math.sqrt(vec!.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  it('produces similar embeddings for similar text', async () => {
    await embedder.init();
    const v1 = await embedder.embed('how to fix a bug in TypeScript');
    const v2 = await embedder.embed('debugging a TypeScript issue');
    const v3 = await embedder.embed('recipe for chocolate cake');

    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v3).not.toBeNull();

    const cosineSim = (a: Float32Array, b: Float32Array) =>
      a.reduce((sum, val, i) => sum + val * b[i], 0);

    const simRelated = cosineSim(v1!, v2!);
    const simUnrelated = cosineSim(v1!, v3!);

    // Related texts should have higher cosine similarity than unrelated
    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.5);
  });

  it('serializes and deserializes embeddings via toBlob/fromBlob', async () => {
    await embedder.init();
    const vec = await embedder.embed('roundtrip test');
    expect(vec).not.toBeNull();

    const blob = Embedder.toBlob(vec!);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.byteLength).toBe(384 * 4); // 384 float32s

    const restored = Embedder.fromBlob(blob);
    expect(restored.length).toBe(384);
    expect(restored[0]).toBeCloseTo(vec![0], 6);
    expect(restored[383]).toBeCloseTo(vec![383], 6);
  });
});
