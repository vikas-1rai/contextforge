#!/usr/bin/env node
/**
 * Downloads native prebuilt binaries for all target platforms.
 * This enables cross-platform VSIX builds from a single machine.
 *
 * Downloads:
 *   - better-sqlite3 prebuilds from GitHub releases
 *   - sqlite-vec platform packages from npm
 *
 * onnxruntime-node already ships all platforms in one package.
 *
 * Usage: node scripts/fetch-native-deps.js [target...]
 *   No args = all targets. Or specify: darwin-arm64 win32-x64 linux-x64
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const zlib = require('zlib');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const ALL_TARGETS = [
  'darwin-arm64', 'darwin-x64',
  'win32-x64', 'linux-x64', 'linux-arm64',
];

const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0 ? requestedTargets : ALL_TARGETS;

// --- better-sqlite3 prebuilds ---

async function fetchBetterSqlite3Prebuilds() {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'));
  const version = pkgJson.version;
  const prebuildsDir = path.join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds');
  fs.mkdirSync(prebuildsDir, { recursive: true });

  // Map target to prebuild naming convention
  const prebuildMap = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'win32-x64': 'win32-x64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
  };

  for (const target of targets) {
    const prebuildTarget = prebuildMap[target];
    if (!prebuildTarget) continue;

    const targetDir = path.join(prebuildsDir, prebuildTarget);
    // Check if we already have the prebuild
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).some(f => f.endsWith('.node'))) {
      console.log(`  better-sqlite3 [${target}]: already exists`);
      continue;
    }

    // Download via prebuild-install
    console.log(`  better-sqlite3 [${target}]: downloading prebuild v${version}...`);
    try {
      const [platform, arch] = target.split('-');
      execSync(
        `npx prebuild-install --platform ${platform} --arch ${arch} --tag-prefix v --download`,
        {
          cwd: path.join(ROOT, 'node_modules', 'better-sqlite3'),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            npm_config_platform: platform,
            npm_config_arch: arch,
          },
        }
      );
      // prebuild-install puts the file in prebuilds/<platform>-<arch>/
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).some(f => f.endsWith('.node'))) {
        console.log(`  better-sqlite3 [${target}]: ✓ downloaded`);
      } else {
        // It may have put it in build/Release instead; copy it
        const buildNode = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
        if (target === `${process.platform}-${process.arch}` && fs.existsSync(buildNode)) {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(buildNode, path.join(targetDir, 'better-sqlite3.node'));
          console.log(`  better-sqlite3 [${target}]: ✓ copied from build/`);
        } else {
          console.warn(`  better-sqlite3 [${target}]: ⚠ prebuild not available, will need compilation on target`);
        }
      }
    } catch (err) {
      console.warn(`  better-sqlite3 [${target}]: ⚠ download failed — ${err.message?.split('\n')[0]}`);
    }
  }
}

// --- sqlite-vec platform packages ---

async function fetchSqliteVecPackages() {
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const vecOs = platform === 'win32' ? 'windows' : platform;
    const pkgName = `sqlite-vec-${vecOs}-${arch}`;
    const pkgDir = path.join(ROOT, 'node_modules', pkgName);

    if (fs.existsSync(pkgDir)) {
      console.log(`  ${pkgName}: already exists`);
      continue;
    }

    console.log(`  ${pkgName}: downloading from npm...`);
    try {
      // Use npm pack to download the tarball, then extract it
      const tmpDir = path.join(ROOT, '.tmp-sqlite-vec');
      fs.mkdirSync(tmpDir, { recursive: true });

      execSync(`npm pack ${pkgName}@0.1.9 --pack-destination "${tmpDir}"`, {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Find the tarball
      const tarball = fs.readdirSync(tmpDir).find(f => f.startsWith(pkgName.replace(/@/g, '')) || f.includes('sqlite-vec'));
      if (tarball) {
        // Extract to node_modules
        fs.mkdirSync(pkgDir, { recursive: true });
        execSync(`tar xzf "${path.join(tmpDir, tarball)}" --strip-components=1 -C "${pkgDir}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(`  ${pkgName}: ✓ installed`);
      } else {
        console.warn(`  ${pkgName}: ⚠ tarball not found after npm pack`);
      }

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`  ${pkgName}: ⚠ download failed — ${err.message?.split('\n')[0]}`);
    }
  }
}

async function main() {
  console.log(`\nFetching native dependencies for: ${targets.join(', ')}\n`);

  console.log('1. better-sqlite3 prebuilds:');
  await fetchBetterSqlite3Prebuilds();

  console.log('\n2. sqlite-vec platform packages:');
  await fetchSqliteVecPackages();

  console.log('\n3. onnxruntime-node: ships all platforms ✓');

  console.log('\nDone. You can now run: npm run package:all\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
