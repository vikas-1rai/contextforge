/**
 * Prepares the server/ directory for packaging:
 *   1. Cleans server/node_modules and server/mcp.js
 *   2. Copies the bundled MCP server
 *   3. Copies native modules for the target platform
 *   4. Copies the ONNX model
 *
 * Cross-platform (no shell commands). Used by `npm run copy-server`.
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const SERVER_MODULES = path.join(SERVER_DIR, 'node_modules');
const MCP_SRC = path.join(__dirname, '..', '..', 'core', 'bundle', 'mcp.bundle.js');
const MCP_DEST = path.join(SERVER_DIR, 'mcp.js');

function rmSync(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

// 1. Clean
rmSync(SERVER_MODULES);
rmSync(MCP_DEST);
fs.mkdirSync(SERVER_MODULES, { recursive: true });

// 2. Copy MCP bundle
if (!fs.existsSync(MCP_SRC)) {
  console.error('MCP bundle not found. Run `npm run bundle` in packages/core first.');
  process.exit(1);
}
fs.copyFileSync(MCP_SRC, MCP_DEST);
console.log('Copied mcp.bundle.js → server/mcp.js');

// 3. Copy native modules (delegates to copy-native-modules.js)
require('./copy-native-modules');

// 4. Copy model (delegates to copy-model.js)
require('./copy-model');
