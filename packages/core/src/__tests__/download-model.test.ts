import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../scripts/download-model.js');
const SCRIPT_CWD = path.resolve(__dirname, '../../../');

function runScript(tmpHome: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: SCRIPT_CWD,
    env: {
      ...process.env,
      HOME: tmpHome,
      ...extraEnv,
    },
    timeout: 10000,
  });
}

function makeLocalModelSource() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-src-'));
  fs.mkdirSync(path.join(source, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config.json'), '{}');
  fs.writeFileSync(path.join(source, 'tokenizer.json'), JSON.stringify({ model: { vocab: {} } }));
  fs.writeFileSync(path.join(source, 'tokenizer_config.json'), '{}');
  fs.writeFileSync(path.join(source, 'onnx', 'model.onnx'), 'onnx');
  return source;
}

function makeEmptySource() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-empty-src-'));
}

describe('download-model.js', () => {
  describe('script integrity', () => {
    it('file exists', () => {
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });

    it('has valid JavaScript syntax', () => {
      const result = spawnSync(process.execPath, ['--check', SCRIPT], {
        encoding: 'utf8',
        cwd: SCRIPT_CWD,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('does not require any Hugging Face client library', () => {
      const source = fs.readFileSync(SCRIPT, 'utf8');
      expect(source).not.toMatch(/huggingface/i);
    });
  });

  describe('cache directory setup', () => {
    it('creates ~/.contextforge/models before attempting download', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      try {
        runScript(tmpHome);
        const cacheDir = path.join(tmpHome, '.contextforge', 'models');
        expect(fs.existsSync(cacheDir)).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('uses a custom HOME to isolate cache per environment', () => {
      const tmpHome1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      try {
        runScript(tmpHome1);
        runScript(tmpHome2);
        expect(fs.existsSync(path.join(tmpHome1, '.contextforge', 'models'))).toBe(true);
        expect(fs.existsSync(path.join(tmpHome2, '.contextforge', 'models'))).toBe(true);
        // Separate homes should produce separate cache directories
        expect(tmpHome1).not.toBe(tmpHome2);
      } finally {
        fs.rmSync(tmpHome1, { recursive: true, force: true });
        fs.rmSync(tmpHome2, { recursive: true, force: true });
      }
    });
  });

  describe('console output', () => {
    it('prints the cache directory path on startup', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const sourceDir = makeLocalModelSource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir });
        expect(result.stdout).toContain('Cache dir:');
        expect(result.stdout).toContain(path.join(tmpHome, '.contextforge', 'models'));
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    });

    it('prints the model name on startup', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const sourceDir = makeLocalModelSource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir });
        expect(result.stdout).toContain('all-MiniLM-L6-v2');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    });

    it('prints local-only source info on startup', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const sourceDir = makeLocalModelSource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir });
        expect(result.stdout).toContain('Source:');
        expect(result.stdout).toContain('local files only');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    });
  });

  describe('error handling', () => {
    it('exits with code 1 when no local model source exists', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const emptySource = makeEmptySource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: emptySource });
        expect(result.status).toBe(1);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(emptySource, { recursive: true, force: true });
      }
    });

    it('prints "Failed to stage model" to stderr when missing source', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const emptySource = makeEmptySource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: emptySource });
        expect(result.stderr).toContain('Failed to stage model');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(emptySource, { recursive: true, force: true });
      }
    });

    it('prints a local source hint to stderr on failure', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
      const emptySource = makeEmptySource();
      try {
        const result = runScript(tmpHome, { CONTEXTFORGE_MODEL_SOURCE_DIR: emptySource });
        expect(result.stderr).toContain('CONTEXTFORGE_MODEL_SOURCE_DIR');
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(emptySource, { recursive: true, force: true });
      }
    });
  });

  describe('integration (requires cached model)', () => {
    const modelSubdir = path.join('Xenova', 'all-MiniLM-L6-v2');
    const cacheDir = path.join(os.homedir(), '.contextforge', 'models', modelSubdir);
    const requiredFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', path.join('onnx', 'model.onnx')];
    const modelCached = requiredFiles.every(
      (f) => fs.existsSync(path.join(cacheDir, f)) && fs.statSync(path.join(cacheDir, f)).size > 0
    );

    // These tests are skipped unless the full model has been downloaded at least once.
    (modelCached ? it : it.skip)('exits 0 when model is already cached', () => {
      const sourceDir = makeLocalModelSource();
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        cwd: SCRIPT_CWD,
        env: {
          ...process.env,
          HOME: os.homedir(),
          CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir,
        },
        timeout: 30000,
      });
      fs.rmSync(sourceDir, { recursive: true, force: true });
      expect(result.status).toBe(0);
    });

    (modelCached ? it : it.skip)('reports the model is ready when fully cached', () => {
      const sourceDir = makeLocalModelSource();
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        cwd: SCRIPT_CWD,
        env: {
          ...process.env,
          HOME: os.homedir(),
          CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir,
        },
        timeout: 30000,
      });
      fs.rmSync(sourceDir, { recursive: true, force: true });
      expect(result.stdout).toContain('Model ready at');
      expect(result.stdout).toContain('(cached)');
    });

    (modelCached ? it : it.skip)('prints the cache directory in the final output', () => {
      const sourceDir = makeLocalModelSource();
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        cwd: SCRIPT_CWD,
        env: {
          ...process.env,
          HOME: os.homedir(),
          CONTEXTFORGE_MODEL_SOURCE_DIR: sourceDir,
        },
        timeout: 30000,
      });
      fs.rmSync(sourceDir, { recursive: true, force: true });
      expect(result.stdout).toContain(cacheDir);
    });
  });
});
