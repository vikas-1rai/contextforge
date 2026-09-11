#!/usr/bin/env node
/**
 * Download all-MiniLM-L6-v2 for semantic search into the ContextForge cache.
 * The model is downloaded once and used locally by the MCP server.
 */
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const modelSubdir = path.join('Xenova', 'all-MiniLM-L6-v2');
const baseUrl = process.env.CONTEXTFORGE_MODEL_SOURCE_URL ||
  'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main';
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
];
const cacheDir = path.join(os.homedir(), '.contextforge', 'models', modelSubdir);

function download(url, destination, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }

    https.get(url, { headers: { 'User-Agent': 'ContextForge model setup' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      const temporary = `${destination}.part`;
      const output = fs.createWriteStream(temporary);
      response.pipe(output);
      output.on('finish', () => {
        output.close(() => {
          fs.renameSync(temporary, destination);
          resolve();
        });
      });
      output.on('error', (error) => {
        output.destroy();
        fs.rmSync(temporary, { force: true });
        reject(error);
      });
      response.on('error', (error) => {
        output.destroy();
        fs.rmSync(temporary, { force: true });
        reject(error);
      });
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`Model cache: ${cacheDir}`);
  console.log('Downloading all-MiniLM-L6-v2 for local semantic search...\n');

  for (const relativePath of files) {
    const destination = path.join(cacheDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
      console.log(`  ✓ ${relativePath} (cached)`);
      continue;
    }

    process.stdout.write(`  ↓ ${relativePath}...`);
    await download(`${baseUrl}/${relativePath}`, destination);
    console.log(' done');
  }

  console.log(`\n✓ Model ready at ${cacheDir}`);
  console.log('Semantic search is now enabled.');
}

main().catch((error) => {
  console.error(`\nModel download failed: ${error.message}`);
  process.exit(1);
});
