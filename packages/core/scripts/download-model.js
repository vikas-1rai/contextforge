#!/usr/bin/env node
/**
 * Stage the offline all-MiniLM-L6-v2 model for vector search.
 *
 * This script never reaches the network. It copies the model from a local
 * source directory into the user cache at ~/.contextforge/models/.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const MODEL_SUBDIR = path.join('Xenova', 'all-MiniLM-L6-v2');
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
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

function hasModel(dir) {
  return fs.existsSync(path.join(dir, 'onnx', 'model.onnx'));
}

function findSourceDir() {
  const envSource = process.env.CONTEXTFORGE_MODEL_SOURCE_DIR;
  if (envSource) {
    const source = path.resolve(envSource);
    return hasModel(source) ? source : null;
  }

  const sources = [
    path.resolve(__dirname, '..', 'release', 'models', MODEL_SUBDIR),
    path.join(os.homedir(), '.contextforge', 'models', MODEL_SUBDIR),
  ];

  for (const source of sources) {
    if (hasModel(source)) return source;
  }
  return null;
}

async function main() {
  const cacheDir = path.join(os.homedir(), '.contextforge', 'models', MODEL_SUBDIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const sourceDir = findSourceDir();

  console.log('Source:     local files only');
  console.log(`Cache dir:  ${cacheDir}`);
  console.log('Staging all-MiniLM-L6-v2 from local files...\n');

  if (!sourceDir) {
    throw new Error(
      'No local model source found. Set CONTEXTFORGE_MODEL_SOURCE_DIR or place the model in packages/core/release/models/Xenova/all-MiniLM-L6-v2/ before running this script.',
    );
  }

  for (const rel of FILES) {
    const destPath = path.join(cacheDir, rel);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      console.log(`  ✓ ${rel} (cached)`);
      continue;
    }
    const srcPath = path.join(sourceDir, rel);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing required local model file: ${srcPath}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${rel} (copied)`);
  }

  console.log(`\n✓ Model ready at ${cacheDir}`);
  console.log('Vector search is now enabled for contextforge.');
}

main().catch((err) => {
  console.error(`\nFailed to stage model: ${err.message}`);
  console.error('\nPlace the model files locally or set CONTEXTFORGE_MODEL_SOURCE_DIR:');
  console.error('  node scripts/download-model.js');
  process.exit(1);
});
