import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MemoryDatabase } from '../db';
import { CodeStructure, FunctionSig, ClassSig, IndexResult } from '../models';

/**
 * Supported languages and their file extensions.
 */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.xml': 'xml',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.proto': 'protobuf',
  '.dockerfile': 'dockerfile',
};

/**
 * Directories to always skip when indexing.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.output', '__pycache__', '.pytest_cache', '.mypy_cache',
  'venv', '.venv', 'env', '.env', '.idea', '.vscode', 'coverage',
  '.turbo', '.cache', '.parcel-cache', 'vendor', 'Pods',
  'bundle', 'release',
]);

/**
 * Max file size to index (500KB). Larger files are skipped.
 */
const MAX_FILE_SIZE = 500 * 1024;

/**
 * Max source snippet size stored per file (signatures, key definitions).
 */
const MAX_SNIPPET_SIZE = 8000;

export interface IndexOptions {
  /** Specific subdirectory to index (relative to workspace root) */
  pathPrefix?: string;
  /** Only index files matching these extensions (e.g., ['.ts', '.py']) */
  extensions?: string[];
  /** Force re-index even if content hash hasn't changed */
  force?: boolean;
  /** Max files to index in a single run (default: 5000) */
  maxFiles?: number;
  /** Progress callback */
  onProgress?: (indexed: number, total: number, currentFile: string) => void;
}

/**
 * Indexes a codebase directory into the graph database.
 *
 * Walks the file tree, parses each supported file to extract structure
 * (exports, imports, functions, classes, interfaces), and stores the
 * structural information in the DB. Raw file content is NOT stored —
 * only signatures and structural summaries.
 *
 * Uses content hashing for incremental indexing: unchanged files are skipped.
 */
export class CodebaseIndexer {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  async index(workspace: string, options?: IndexOptions): Promise<IndexResult> {
    await this.db.init();

    const result: IndexResult = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesUnchanged: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      errors: [],
    };

    const rootDir = options?.pathPrefix
      ? path.join(workspace, options.pathPrefix)
      : workspace;

    if (!fs.existsSync(rootDir)) {
      result.errors.push(`Directory not found: ${rootDir}`);
      return result;
    }

    // Collect files
    const files = this.collectFiles(rootDir, workspace, options);
    const maxFiles = options?.maxFiles ?? 5000;

    if (files.length > maxFiles) {
      files.length = maxFiles;
    }

    // Load gitignore patterns
    const ignorePatterns = this.loadGitignore(workspace);

    // Index each file
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const relativePath = path.relative(workspace, filePath);

      if (this.isIgnored(relativePath, ignorePatterns)) {
        result.filesSkipped++;
        continue;
      }

      options?.onProgress?.(i + 1, files.length, relativePath);

      try {
        const indexed = await this.indexFile(workspace, filePath, relativePath, options?.force);
        if (indexed === 'indexed') {
          result.filesIndexed++;
          result.entitiesCreated++;
        } else if (indexed === 'unchanged') {
          result.filesUnchanged++;
        } else {
          result.filesSkipped++;
        }
      } catch (err) {
        result.errors.push(`${relativePath}: ${err}`);
        if (result.errors.length > 50) {
          result.errors.push('... (truncated, too many errors)');
          break;
        }
      }
    }

    // Build cross-file relations
    const relCount = await this.buildCrossFileRelations(workspace);
    result.relationsCreated = relCount;

    // Prune files that no longer exist
    const existingPaths = new Set(files.map(f => path.relative(workspace, f)));
    const pruned = await this.db.pruneDeletedFiles(workspace, existingPaths);
    if (pruned > 0) {
      result.errors.push(`Pruned ${pruned} entries for deleted files`);
    }

    return result;
  }

  private async indexFile(
    workspace: string,
    filePath: string,
    relativePath: string,
    force?: boolean,
  ): Promise<'indexed' | 'unchanged' | 'skipped'> {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE || stat.size === 0) return 'skipped';

    const ext = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_MAP[ext];
    if (!language) return 'skipped';

    const content = fs.readFileSync(filePath, 'utf8');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    // Check if already indexed with same hash
    if (!force) {
      const existingHash = this.db.getContentHash(workspace, relativePath);
      if (existingHash === contentHash) return 'unchanged';
    }

    // Parse structure
    const structure = this.parseStructure(content, language, relativePath);

    // Extract key signatures as source snippet
    const snippet = this.extractSnippet(content, language, structure);

    // Upsert the file entity
    const entity = await this.db.upsertEntity({
      type: 'file',
      name: relativePath,
      workspace,
      metadata: { language, lineCount: String(content.split('\n').length), size: String(stat.size) },
    });

    // Upsert code content
    await this.db.upsertCodeContent({
      entityId: entity.id,
      workspace,
      filePath: relativePath,
      language,
      contentHash,
      structure,
      sourceSnippet: snippet,
      lineCount: content.split('\n').length,
      sizeBytes: stat.size,
    });

    // Create entities for exported functions/classes
    for (const fn of structure.functions.filter(f => f.exported)) {
      const fnEntity = await this.db.upsertEntity({
        type: 'function',
        name: fn.name,
        workspace,
        metadata: { file: relativePath, params: fn.params, returnType: fn.returnType || '' },
      });
      await this.db.addRelation({
        sourceId: entity.id,
        targetId: fnEntity.id,
        type: 'contains',
        context: `defined in ${relativePath}`,
        conversationId: 'indexer',
      });
    }

    for (const cls of structure.classes.filter(c => c.exported)) {
      const clsEntity = await this.db.upsertEntity({
        type: 'class',
        name: cls.name,
        workspace,
        metadata: {
          file: relativePath,
          methods: cls.methods.join(', '),
          extends: cls.extends || '',
        },
      });
      await this.db.addRelation({
        sourceId: entity.id,
        targetId: clsEntity.id,
        type: 'contains',
        context: `defined in ${relativePath}`,
        conversationId: 'indexer',
      });
    }

    // Store imports as facts
    for (const imp of structure.imports) {
      await this.db.upsertFact(
        { entityId: entity.id, key: `imports:${imp.from}`, value: imp.name, confidence: 1.0, sourceConversationId: 'indexer' },
        entity.id,
      );
    }

    return 'indexed';
  }

  /**
   * Build cross-file relations from import graphs.
   */
  private async buildCrossFileRelations(workspace: string): Promise<number> {
    const allCode = await this.db.getCodeContext(workspace, { limit: 10000 });
    let count = 0;

    // Build a map of file path → entity ID
    const filePathToEntity = new Map<string, string>();
    for (const code of allCode) {
      filePathToEntity.set(code.filePath, code.entityId);
    }

    for (const code of allCode) {
      for (const imp of code.structure.imports) {
        // Resolve relative imports to workspace paths
        if (imp.from.startsWith('.')) {
          const resolved = this.resolveImportPath(code.filePath, imp.from, filePathToEntity);
          if (resolved) {
            await this.db.addRelation({
              sourceId: code.entityId,
              targetId: resolved,
              type: 'depends_on',
              context: `imports ${imp.name} from ${imp.from}`,
              conversationId: 'indexer',
            });
            count++;
          }
        } else {
          // External package — create library entity + uses relation
          const libEntity = await this.db.upsertEntity({
            type: 'library',
            name: imp.from,
            workspace,
            metadata: {},
          });
          await this.db.addRelation({
            sourceId: code.entityId,
            targetId: libEntity.id,
            type: 'uses',
            context: `imports ${imp.name}`,
            conversationId: 'indexer',
          });
          count++;
        }
      }
    }

    return count;
  }

  private resolveImportPath(
    fromFile: string,
    importPath: string,
    knownFiles: Map<string, string>,
  ): string | null {
    const dir = path.dirname(fromFile);
    const resolved = path.normalize(path.join(dir, importPath));

    // Try exact match, then common extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx'];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      const entityId = knownFiles.get(candidate);
      if (entityId) return entityId;
    }
    return null;
  }

  // ─── File collection ──────────────────────────────────────

  private collectFiles(dir: string, workspace: string, options?: IndexOptions): string[] {
    const files: string[] = [];
    const allowedExts = options?.extensions
      ? new Set(options.extensions.map(e => e.startsWith('.') ? e : '.' + e))
      : null;

    const walk = (currentDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!LANGUAGE_MAP[ext]) continue;
          if (allowedExts && !allowedExts.has(ext)) continue;
          files.push(fullPath);
        }
      }
    };

    walk(dir);
    return files;
  }

  // ─── Gitignore ────────────────────────────────────────────

  private loadGitignore(workspace: string): RegExp[] {
    const gitignorePath = path.join(workspace, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    const patterns: RegExp[] = [];
    const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;

      // Convert gitignore glob to regex (simplified)
      let regex = line
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
        .replace(/\*\*/g, '___DOUBLESTAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/___DOUBLESTAR___/g, '.*')
        .replace(/\?/g, '[^/]');

      if (line.endsWith('/')) {
        regex = regex + '.*';
      }
      if (!line.startsWith('/')) {
        regex = '(^|.*/?)' + regex;
      }

      try {
        patterns.push(new RegExp(regex));
      } catch {
        // Invalid pattern, skip
      }
    }

    return patterns;
  }

  private isIgnored(relativePath: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(relativePath));
  }

  // ─── Structure Parsing ────────────────────────────────────

  /**
   * Parse file content to extract structural information.
   * Language-aware but lightweight (regex-based, no AST).
   */
  parseStructure(content: string, language: string, filePath: string): CodeStructure {
    const structure: CodeStructure = {
      exports: [],
      imports: [],
      functions: [],
      classes: [],
      interfaces: [],
      types: [],
      constants: [],
    };

    switch (language) {
      case 'typescript':
      case 'javascript':
        this.parseTypeScriptStructure(content, structure);
        break;
      case 'python':
        this.parsePythonStructure(content, structure);
        break;
      case 'go':
        this.parseGoStructure(content, structure);
        break;
      case 'java':
      case 'kotlin':
      case 'csharp':
        this.parseJavaLikeStructure(content, structure);
        break;
      case 'json':
        this.parseJsonStructure(content, structure, filePath);
        break;
      default:
        // Generic: just extract obvious patterns
        this.parseGenericStructure(content, structure);
        break;
    }

    return structure;
  }

  private parseTypeScriptStructure(content: string, s: CodeStructure): void {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(/^import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const names = (importMatch[1] || importMatch[2] || '').trim();
        const from = importMatch[3];
        s.imports.push({ name: names, from });
        continue;
      }

      // Re-exports
      const reexportMatch = trimmed.match(/^export\s+(?:{([^}]+)}|(\*))\s+from\s+['"]([^'"]+)['"]/);
      if (reexportMatch) {
        s.exports.push(trimmed.slice(0, 120));
        continue;
      }

      // Exported functions
      const exportFnMatch = trimmed.match(
        /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/,
      );
      if (exportFnMatch) {
        s.functions.push({
          name: exportFnMatch[1],
          params: exportFnMatch[2].trim(),
          returnType: exportFnMatch[3],
          exported: true,
        });
        s.exports.push(exportFnMatch[1]);
        continue;
      }

      // Non-exported functions
      const fnMatch = trimmed.match(
        /^(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/,
      );
      if (fnMatch) {
        s.functions.push({ name: fnMatch[1], params: fnMatch[2].trim(), returnType: fnMatch[3], exported: false });
        continue;
      }

      // Exported const/let arrow functions
      const arrowMatch = trimmed.match(
        /^export\s+(?:const|let)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:async\s*)?\(([^)]*)\)(?:\s*:\s*([^\s=]+))?\s*=>/,
      );
      if (arrowMatch) {
        s.functions.push({ name: arrowMatch[1], params: arrowMatch[2].trim(), returnType: arrowMatch[3], exported: true });
        s.exports.push(arrowMatch[1]);
        continue;
      }

      // Non-exported arrow functions
      const arrowMatch2 = trimmed.match(
        /^(?:const|let)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(?:async\s*)?\(([^)]*)\)(?:\s*:\s*([^\s=]+))?\s*=>/,
      );
      if (arrowMatch2) {
        s.functions.push({ name: arrowMatch2[1], params: arrowMatch2[2].trim(), returnType: arrowMatch2[3], exported: false });
        continue;
      }

      // Classes
      const classMatch = trimmed.match(
        /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/,
      );
      if (classMatch) {
        const isExported = trimmed.startsWith('export');
        s.classes.push({
          name: classMatch[1],
          methods: [],
          properties: [],
          exported: isExported,
          extends: classMatch[2],
          implements: classMatch[3]?.split(',').map(s => s.trim()),
        });
        if (isExported) s.exports.push(classMatch[1]);
        continue;
      }

      // Interfaces
      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (ifaceMatch) {
        s.interfaces.push(ifaceMatch[1]);
        if (trimmed.startsWith('export')) s.exports.push(ifaceMatch[1]);
        continue;
      }

      // Type aliases
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/);
      if (typeMatch) {
        s.types.push(typeMatch[1]);
        if (trimmed.startsWith('export')) s.exports.push(typeMatch[1]);
        continue;
      }

      // Exported constants
      const constMatch = trimmed.match(/^export\s+const\s+(\w+)\s*(?::\s*([^=]+))?\s*=/);
      if (constMatch && !trimmed.includes('=>')) {
        s.constants.push(constMatch[1]);
        s.exports.push(constMatch[1]);
      }
    }

    // Fill class methods from content
    for (const cls of s.classes) {
      const classRegex = new RegExp(`class\\s+${cls.name}[^{]*\\{([\\s\\S]*?)^\\}`, 'm');
      const classBody = content.match(classRegex);
      if (classBody) {
        const methodRegex = /(?:public|private|protected|static|async|get|set|\s)*(\w+)\s*\([^)]*\)/g;
        let match: RegExpExecArray | null;
        while ((match = methodRegex.exec(classBody[1])) !== null) {
          const name = match[1];
          if (!['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name) && !cls.methods.includes(name)) {
            cls.methods.push(name);
          }
        }
      }
    }
  }

  private parsePythonStructure(content: string, s: CodeStructure): void {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
      if (importMatch) {
        const from = importMatch[1] || importMatch[2].split(',')[0].trim();
        const names = importMatch[2].replace(/\s+as\s+\w+/g, '').trim();
        s.imports.push({ name: names, from });
        continue;
      }

      // Functions
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S+))?/);
      if (fnMatch) {
        const isPrivate = fnMatch[1].startsWith('_');
        s.functions.push({
          name: fnMatch[1],
          params: fnMatch[2].trim(),
          returnType: fnMatch[3],
          exported: !isPrivate,
        });
        if (!isPrivate) s.exports.push(fnMatch[1]);
        continue;
      }

      // Classes
      const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?/);
      if (classMatch) {
        s.classes.push({
          name: classMatch[1],
          methods: [],
          properties: [],
          exported: !classMatch[1].startsWith('_'),
          extends: classMatch[2]?.split(',')[0]?.trim(),
        });
        if (!classMatch[1].startsWith('_')) s.exports.push(classMatch[1]);
        continue;
      }

      // Module-level constants
      const constMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*/);
      if (constMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
        s.constants.push(constMatch[1]);
      }
    }
  }

  private parseGoStructure(content: string, s: CodeStructure): void {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(/^\s*"([^"]+)"/);
      if (importMatch) {
        const pkg = importMatch[1];
        s.imports.push({ name: pkg.split('/').pop() || pkg, from: pkg });
        continue;
      }

      // Functions
      const fnMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*\(?([^){]*)\)?)?/);
      if (fnMatch) {
        const isExported = fnMatch[1][0] === fnMatch[1][0].toUpperCase();
        s.functions.push({
          name: fnMatch[1],
          params: fnMatch[2].trim(),
          returnType: fnMatch[3]?.trim(),
          exported: isExported,
        });
        if (isExported) s.exports.push(fnMatch[1]);
        continue;
      }

      // Structs
      const structMatch = trimmed.match(/^type\s+(\w+)\s+struct/);
      if (structMatch) {
        const isExported = structMatch[1][0] === structMatch[1][0].toUpperCase();
        s.classes.push({
          name: structMatch[1],
          methods: [],
          properties: [],
          exported: isExported,
        });
        if (isExported) s.exports.push(structMatch[1]);
        continue;
      }

      // Interfaces
      const ifaceMatch = trimmed.match(/^type\s+(\w+)\s+interface/);
      if (ifaceMatch) {
        s.interfaces.push(ifaceMatch[1]);
        continue;
      }
    }
  }

  private parseJavaLikeStructure(content: string, s: CodeStructure): void {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(/^import\s+(?:static\s+)?([^;]+)/);
      if (importMatch) {
        const pkg = importMatch[1].trim();
        s.imports.push({ name: pkg.split('.').pop() || pkg, from: pkg });
        continue;
      }

      // Classes
      const classMatch = trimmed.match(
        /^(?:public|private|protected)?\s*(?:abstract|final|data|sealed)?\s*class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/,
      );
      if (classMatch) {
        s.classes.push({
          name: classMatch[1],
          methods: [],
          properties: [],
          exported: trimmed.includes('public'),
          extends: classMatch[2],
          implements: classMatch[3]?.split(',').map(s => s.trim()),
        });
        s.exports.push(classMatch[1]);
        continue;
      }

      // Interfaces
      const ifaceMatch = trimmed.match(/^(?:public\s+)?interface\s+(\w+)/);
      if (ifaceMatch) {
        s.interfaces.push(ifaceMatch[1]);
        continue;
      }

      // Methods
      const methodMatch = trimmed.match(
        /^(?:public|private|protected)?\s*(?:static|abstract|final|override|suspend)?\s*(?:fun\s+)?(?:\w+(?:<[^>]*>)?\s+)?(\w+)\s*\([^)]*\)/,
      );
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'class', 'interface', 'import', 'return'].includes(methodMatch[1])) {
        s.functions.push({ name: methodMatch[1], params: '', exported: true });
      }
    }
  }

  private parseJsonStructure(content: string, s: CodeStructure, filePath: string): void {
    try {
      const obj = JSON.parse(content);
      if (filePath.endsWith('package.json')) {
        s.description = obj.description;
        if (obj.dependencies) s.exports.push(...Object.keys(obj.dependencies).map(d => `dep:${d}`));
        if (obj.devDependencies) s.exports.push(...Object.keys(obj.devDependencies).map(d => `devDep:${d}`));
        if (obj.scripts) s.constants.push(...Object.keys(obj.scripts).map(s => `script:${s}`));
      } else if (filePath.endsWith('tsconfig.json')) {
        s.description = `TypeScript config: ${JSON.stringify(obj.compilerOptions || {}).slice(0, 200)}`;
      } else {
        s.constants.push(...Object.keys(obj).slice(0, 20));
      }
    } catch {
      // Invalid JSON
    }
  }

  private parseGenericStructure(content: string, s: CodeStructure): void {
    // Just extract function-like patterns
    const fnRegex = /(?:function|def|fn|func|sub|proc)\s+(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = fnRegex.exec(content)) !== null) {
      s.functions.push({ name: match[1], params: '', exported: true });
    }
  }

  // ─── Source Snippet Extraction ────────────────────────────

  /**
   * Extract key source snippets: function/class signatures, type definitions.
   * These are stored verbatim so the agent can reference them without re-reading files.
   */
  private extractSnippet(content: string, language: string, structure: CodeStructure): string {
    const snippets: string[] = [];
    const lines = content.split('\n');

    if (language === 'typescript' || language === 'javascript') {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // Interface/type definitions — capture full block
        if (/^(?:export\s+)?(?:interface|type)\s+\w+/.test(trimmed)) {
          const block = this.captureBlock(lines, i);
          if (block.length < 500) snippets.push(block);
        }

        // Exported function signatures (first line only)
        if (/^export\s+(?:default\s+)?(?:async\s+)?function/.test(trimmed) ||
            /^export\s+(?:const|let)\s+\w+.*=>/.test(trimmed)) {
          snippets.push(lines[i]);
        }

        // Class declarations (with first few methods)
        if (/^(?:export\s+)?(?:abstract\s+)?class\s+/.test(trimmed)) {
          const block = this.captureBlock(lines, i);
          // Trim to just signatures (remove method bodies)
          const sigLines = block.split('\n').filter(l =>
            /^\s*(export|class|constructor|public|private|protected|static|async|get|set|\w+\()/.test(l) ||
            l.trim() === '}' || l.trim() === '',
          );
          snippets.push(sigLines.join('\n'));
        }
      }
    } else if (language === 'python') {
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // Function/class signatures with docstrings
        if (/^(?:async\s+)?def\s+/.test(trimmed) || /^class\s+/.test(trimmed)) {
          snippets.push(lines[i]);
          // Capture docstring if present
          if (i + 1 < lines.length && lines[i + 1].trim().startsWith('"""')) {
            let j = i + 1;
            while (j < lines.length) {
              snippets.push(lines[j]);
              if (j > i + 1 && lines[j].trim().endsWith('"""')) break;
              j++;
            }
          }
        }
      }
    }

    const result = snippets.join('\n');
    return result.length > MAX_SNIPPET_SIZE ? result.slice(0, MAX_SNIPPET_SIZE) + '\n// ...(truncated)' : result;
  }

  private captureBlock(lines: string[], startIdx: number): string {
    let depth = 0;
    let started = false;
    const result: string[] = [];

    for (let i = startIdx; i < lines.length && result.length < 30; i++) {
      result.push(lines[i]);
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '(') { depth++; started = true; }
        if (ch === '}' || ch === ')') depth--;
      }
      if (started && depth <= 0) break;
    }

    return result.join('\n');
  }
}
