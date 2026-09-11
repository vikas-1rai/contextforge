const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const buildBinary = process.argv.includes('--binary');
const bundleDir = path.join(__dirname, 'bundle');
const distDir = path.join(__dirname, 'dist');

async function build() {
  fs.mkdirSync(bundleDir, { recursive: true });

  console.log('Step 1: Bundle with esbuild...');
  await esbuild.build({
    entryPoints: [path.join(distDir, 'server', 'mcp.js')],
    bundle: true,
    outfile: path.join(bundleDir, 'mcp.bundle.js'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    // Native addons — must stay external
    external: ['better-sqlite3', 'onnxruntime-node'],
    // Shebang comes from src/mcp.ts — don't duplicate via banner
    minify: true,
  });
  console.log('  → bundle/mcp.bundle.js');

  console.log('Step 2: Obfuscate...');
  const JavaScriptObfuscator = require('javascript-obfuscator');
  const bundledCode = fs.readFileSync(path.join(bundleDir, 'mcp.bundle.js'), 'utf8');
  const obfuscated = JavaScriptObfuscator.obfuscate(bundledCode, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    splitStrings: true,
    splitStringsChunkLength: 8,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false, // keep require() etc working
    selfDefending: false, // breaks in pkg
    target: 'node',
  });
  fs.writeFileSync(path.join(bundleDir, 'mcp.obfuscated.js'), obfuscated.getObfuscatedCode());
  console.log('  → bundle/mcp.obfuscated.js');

  // Copy native modules alongside bundle
  function copyNativeModule(moduleName) {
    const modSrc = path.dirname(require.resolve(moduleName));
    const modDest = path.join(bundleDir, 'node_modules', moduleName);
    fs.mkdirSync(modDest, { recursive: true });
    fs.cpSync(modSrc, modDest, { recursive: true });
    console.log(`  → Copied ${moduleName} native module`);
  }

  copyNativeModule('better-sqlite3');
  copyNativeModule('onnxruntime-node');

  // Create a package.json for pkg
  fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify({
    name: 'contextforge',
    version: '0.1.0',
    bin: 'mcp.bundle.js',
    pkg: {
      assets: [
        'node_modules/better-sqlite3/**/*',
        'node_modules/onnxruntime-node/**/*',
      ],
      targets: ['node18'],
      outputPath: 'out',
    },
  }, null, 2));

  if (buildBinary) {
    console.log('Step 3: Build native binary with pkg...');
    fs.mkdirSync(path.join(bundleDir, 'out'), { recursive: true });
    execSync(
      `npx @yao-pkg/pkg@5.15.0 . --compress GZip`,
      { cwd: bundleDir, stdio: 'inherit' },
    );

    // Step 4: Create distribution folder
    console.log('Step 4: Create distribution package...');
    const distOut = path.join(__dirname, 'release');
    fs.mkdirSync(distOut, { recursive: true });

    // Copy binary
    const outDir = path.join(bundleDir, 'out');
    const binaryFiles = fs.readdirSync(outDir);
    for (const f of binaryFiles) {
      fs.cpSync(path.join(outDir, f), path.join(distOut, f));
      fs.chmodSync(path.join(distOut, f), 0o755);
    }

    // Copy native addons alongside binary
    const betterSqliteDest = path.join(distOut, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(betterSqliteDest, { recursive: true });
    fs.cpSync(path.join(bundleDir, 'node_modules', 'better-sqlite3'), betterSqliteDest, { recursive: true });

    const ortReleaseDest = path.join(distOut, 'node_modules', 'onnxruntime-node');
    fs.mkdirSync(ortReleaseDest, { recursive: true });
    fs.cpSync(path.join(bundleDir, 'node_modules', 'onnxruntime-node'), ortReleaseDest, { recursive: true });

    // Prune vendored model libraries from the distributable; the release uses
    // the bundled offline model files under release/models/ instead.
    fs.rmSync(path.join(distOut, 'node_modules', '@' + 'huggingface'), { recursive: true, force: true });

    // Copy the ONNX model beside the binary so vector search works offline.
    // The embedder looks for <execDir>/models/... .
    const modelSubpath = path.join('Xenova', 'all-MiniLM-L6-v2');
    const modelSources = [
      path.join(os.homedir(), '.contextforge', 'models', modelSubpath),
      path.join(__dirname, '..', 'vscode-extension', 'server', 'models', modelSubpath),
    ];
    const modelSrc = modelSources.find(
      (dir) => fs.existsSync(path.join(dir, 'onnx', 'model.onnx')),
    );
    if (modelSrc) {
      const modelDest = path.join(distOut, 'models', modelSubpath);
      fs.mkdirSync(modelDest, { recursive: true });
      fs.cpSync(modelSrc, modelDest, { recursive: true });
      console.log(`  → Bundled model from ${modelSrc}`);
    } else {
      console.warn('  ⚠ Model not found locally — release will NOT include the ONNX model.');
      console.warn('    Place the model files in ~/.contextforge/models/Xenova/all-MiniLM-L6-v2/');
      console.warn('    or in packages/core/release/models/Xenova/all-MiniLM-L6-v2/, then rebuild.');
    }

    // List output
    console.log('\nRelease package:');
    let totalSize = 0;
    function walkDir(dir, prefix = '') {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walkDir(full, prefix + f + '/');
        } else {
          totalSize += stat.size;
          if (stat.size > 100000) { // only show files > 100KB
            console.log(`  ${prefix}${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          }
        }
      }
    }
    walkDir(distOut);
    console.log(`  Total: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`\nDistribute: ${distOut}/`);
    console.log('Teammates copy this folder to ~/.contextforge/ and point MCP config at the binary.');
  } else {
    console.log('\nBundle ready at: bundle/mcp.obfuscated.js');
    console.log('Run "npm run binary" to compile to native binary.');
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
