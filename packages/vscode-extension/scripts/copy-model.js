/**
 * Copy the ONNX model files to server/models/ for bundling with the extension.
 * Works cross-platform (no shell commands).
 *
 * Searches for the model in:
 *   1. ~/.contextforge/models/Xenova/all-MiniLM-L6-v2/
 *   2. packages/core/release/models/Xenova/all-MiniLM-L6-v2/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_SUBPATH = path.join('Xenova', 'all-MiniLM-L6-v2');
const DEST = path.join(__dirname, '..', 'server', 'models', MODEL_SUBPATH);

const SEARCH_PATHS = [
  path.join(os.homedir(), '.contextforge', 'models', MODEL_SUBPATH),
  path.join(__dirname, '..', '..', 'core', 'release', 'models', MODEL_SUBPATH),
];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let found = false;
for (const srcDir of SEARCH_PATHS) {
  if (fs.existsSync(path.join(srcDir, 'onnx', 'model.onnx'))) {
    console.log(`  model: copying from ${srcDir}`);
    copyDirSync(srcDir, DEST);
    found = true;
    break;
  }
}

if (!found) {
  console.warn('  ⚠ Model not found. Vector search will be disabled.');
  console.warn('  Searched:', SEARCH_PATHS.join(', '));
  // Create empty dir so the build doesn't fail
  fs.mkdirSync(DEST, { recursive: true });
}
