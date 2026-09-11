/**
 * Copy only the runtime-essential files from native modules into server/node_modules.
 * Platform-aware: copies only binaries matching the current build target.
 *
 * For platform-specific VSIX builds, set CONTEXTFORGE_TARGET to override:
 *   CONTEXTFORGE_TARGET=win32-x64 node scripts/copy-native-modules.js
 *
 * Supported targets: darwin-arm64, darwin-x64, win32-x64, win32-arm64, linux-x64, linux-arm64
 */
const fs = require('fs');
const path = require('path');

// --- Platform detection ---
const TARGET = process.env.CONTEXTFORGE_TARGET || `${process.platform}-${process.arch}`;
const [TARGET_PLATFORM, TARGET_ARCH] = TARGET.split('-');

const SUPPORTED_TARGETS = [
  'darwin-arm64', 'darwin-x64',
  'win32-x64', 'win32-arm64',
  'linux-x64', 'linux-arm64',
];

if (!SUPPORTED_TARGETS.includes(TARGET)) {
  console.error(`Unsupported target: ${TARGET}`);
  console.error(`Supported: ${SUPPORTED_TARGETS.join(', ')}`);
  process.exit(1);
}

console.log(`Building for target: ${TARGET}`);

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_MODULES = path.join(__dirname, '..', 'server', 'node_modules');

function copyFileEnsureDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyGlob(srcDir, destDir, patterns) {
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, relPath);
      } else {
        if (patterns.some(p => p(relPath))) {
          copyFileEnsureDir(srcPath, path.join(destDir, relPath));
        }
      }
    }
  }
  walk(srcDir, '');
}

// --- better-sqlite3 ---
const bsq3Src = path.join(ROOT, 'node_modules', 'better-sqlite3');
const bsq3Dest = path.join(SERVER_MODULES, 'better-sqlite3');

// Check for prebuilt binary in prebuilds/<target>/ first, then build/Release/
const prebuildDir = path.join(bsq3Src, 'prebuilds', TARGET);
const hasPrebuild = fs.existsSync(prebuildDir) && fs.readdirSync(prebuildDir).some(f => f.endsWith('.node'));

copyGlob(bsq3Src, bsq3Dest, [
  // Prebuilt binary for target platform (prebuilds/<target>/*.node)
  (f) => hasPrebuild && f.startsWith('prebuilds' + path.sep + TARGET + path.sep) && f.endsWith('.node'),
  // Fallback: compiled binary (build/Release/*.node) — only if no prebuild
  (f) => !hasPrebuild && f.endsWith('.node'),
  // JS runtime files
  (f) => f.startsWith('lib' + path.sep) && f.endsWith('.js'),
  // package.json
  (f) => f === 'package.json',
]);

// --- bindings (required by better-sqlite3 to locate .node) ---
const bindingsSrc = path.join(ROOT, 'node_modules', 'bindings');
const bindingsDest = path.join(SERVER_MODULES, 'bindings');
copyGlob(bindingsSrc, bindingsDest, [
  (f) => f.endsWith('.js') || f === 'package.json',
]);

// --- file-uri-to-path (required by bindings) ---
const furiSrc = path.join(ROOT, 'node_modules', 'file-uri-to-path');
if (fs.existsSync(furiSrc)) {
  const furiDest = path.join(SERVER_MODULES, 'file-uri-to-path');
  copyGlob(furiSrc, furiDest, [
    (f) => f.endsWith('.js') || f === 'package.json',
  ]);
}

// --- onnxruntime-node (copy only target platform binaries) ---
const ortSrc = path.join(ROOT, 'node_modules', 'onnxruntime-node');
const ortDest = path.join(SERVER_MODULES, 'onnxruntime-node');

// Check if binaries exist for this target
const ortBinDir = path.join(ortSrc, 'bin', 'napi-v6', TARGET_PLATFORM, TARGET_ARCH);
const ortHasBinaries = fs.existsSync(ortBinDir);

if (ortHasBinaries) {
  copyGlob(ortSrc, ortDest, [
    // JS dist (no .map, no .d.ts)
    (f) => f.startsWith('dist' + path.sep) && f.endsWith('.js'),
    // Native binaries for target platform only
    (f) => f.includes(path.join(TARGET_PLATFORM, TARGET_ARCH)) &&
           (f.endsWith('.node') || f.endsWith('.dylib') || f.endsWith('.dll') || f.endsWith('.so')),
    // package.json
    (f) => f === 'package.json',
  ]);
} else {
  console.warn(`  ⚠ onnxruntime-node: no binaries for ${TARGET} — vector search will be disabled`);
  // Still copy JS files so require() doesn't fail — embedder handles missing binaries gracefully
  copyGlob(ortSrc, ortDest, [
    (f) => f.startsWith('dist' + path.sep) && f.endsWith('.js'),
    (f) => f === 'package.json',
  ]);
}

// --- onnxruntime-common (required by onnxruntime-node) ---
const ortCommonSrc = path.join(ROOT, 'node_modules', 'onnxruntime-common');
const ortCommonDest = path.join(SERVER_MODULES, 'onnxruntime-common');
copyGlob(ortCommonSrc, ortCommonDest, [
  (f) => f.startsWith('dist' + path.sep) && f.endsWith('.js'),
  (f) => f === 'package.json',
]);
// Patch: onnxruntime-common has "type":"module" but exports CJS via dist/cjs/.
const ortCommonPkg = path.join(ortCommonDest, 'package.json');
const pkg = JSON.parse(fs.readFileSync(ortCommonPkg, 'utf8'));
pkg.type = 'commonjs';
fs.writeFileSync(ortCommonPkg, JSON.stringify(pkg, null, 2));

// --- sqlite-vec (platform-specific native extension) ---
// sqlite-vec uses separate npm packages per platform: sqlite-vec-{os}-{arch}
// The os name differs from Node's process.platform for Windows:
//   process.platform='win32' → npm package uses 'windows'
const vecOs = TARGET_PLATFORM === 'win32' ? 'windows' : TARGET_PLATFORM;
const vecPkgName = `sqlite-vec-${vecOs}-${TARGET_ARCH}`;
const vecSrc = path.join(ROOT, 'node_modules', vecPkgName);

if (fs.existsSync(vecSrc)) {
  const vecDest = path.join(SERVER_MODULES, vecPkgName);
  const vecExt = TARGET_PLATFORM === 'win32' ? '.dll' : TARGET_PLATFORM === 'darwin' ? '.dylib' : '.so';
  copyGlob(vecSrc, vecDest, [
    (f) => f.endsWith(vecExt) || f === 'package.json',
  ]);
  console.log(`  sqlite-vec: ${vecPkgName}`);
} else {
  // On the build machine, only the matching platform's package is installed.
  // This is expected when building for the current platform.
  // For cross-compilation, you'd need to manually provide the package.
  if (TARGET === `${process.platform}-${process.arch}`) {
    console.error(`  ✗ sqlite-vec: package ${vecPkgName} not found. Run: npm install`);
    process.exit(1);
  } else {
    console.warn(`  ⚠ sqlite-vec: ${vecPkgName} not found (cross-building from ${process.platform}-${process.arch})`);
    console.warn(`    Build on the target platform, or place ${vecPkgName} in node_modules manually.`);
  }
}

// Also copy the sqlite-vec JS loader (platform-independent)
const vecLoaderSrc = path.join(ROOT, 'node_modules', 'sqlite-vec');
if (fs.existsSync(vecLoaderSrc)) {
  const vecLoaderDest = path.join(SERVER_MODULES, 'sqlite-vec');
  copyGlob(vecLoaderSrc, vecLoaderDest, [
    (f) => f.endsWith('.js') || f.endsWith('.cjs') || f === 'package.json',
  ]);
}

// --- Summary ---
function dirSize(dir) {
  let total = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

const bsq3Size = (dirSize(bsq3Dest) / 1024 / 1024).toFixed(1);
const ortSize = (dirSize(ortDest) / 1024 / 1024).toFixed(1);
const totalSize = (dirSize(SERVER_MODULES) / 1024 / 1024).toFixed(1);
console.log(`  better-sqlite3: ${bsq3Size} MB`);
console.log(`  onnxruntime-node: ${ortSize} MB${ortHasBinaries ? '' : ' (JS only, no native binaries)'}`);
console.log(`  Total server/node_modules: ${totalSize} MB`);
