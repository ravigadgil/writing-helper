import esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'fs';

const isWatch = process.argv.includes('--watch');

// Ensure dist directories exist
mkdirSync('dist/background', { recursive: true });
mkdirSync('dist/content', { recursive: true });
mkdirSync('dist/popup', { recursive: true });
mkdirSync('dist/icons', { recursive: true });
mkdirSync('dist/wasm', { recursive: true });

// Common build options
const commonOptions = {
  bundle: true,
  target: 'chrome120',
  minify: false,
  sourcemap: false,
  // harper.js has a conditional dynamic import of 'fs' for Node.js environments.
  // Mark it external so esbuild doesn't try to resolve it for the browser build.
  external: ['fs'],
};

// Build service worker (ESM for module type)
const bgBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/background/service-worker.js'],
  outfile: 'dist/background/service-worker.js',
  format: 'esm',
});

// Build content script (IIFE - content scripts can't be ESM)
const contentBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/content/content-script.js'],
  outfile: 'dist/content/content-script.js',
  format: 'iife',
});

// Build popup script
const popupBuild = esbuild.build({
  ...commonOptions,
  entryPoints: ['src/popup/popup.js'],
  outfile: 'dist/popup/popup.js',
  format: 'iife',
});

await Promise.all([bgBuild, contentBuild, popupBuild]);

// Copy static assets
cpSync('src/manifest.json', 'dist/manifest.json');
cpSync('src/content/styles.css', 'dist/content/styles.css');
cpSync('src/popup/popup.html', 'dist/popup/popup.html');
cpSync('src/popup/popup.css', 'dist/popup/popup.css');

if (existsSync('src/icons')) {
  cpSync('src/icons', 'dist/icons', { recursive: true });
}

// Copy WASM binary from harper.js
const wasmSrc = 'node_modules/harper.js/dist/harper_wasm_bg.wasm';
if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, 'dist/wasm/harper_wasm_bg.wasm');
} else {
  console.error('WARNING: WASM binary not found at', wasmSrc);
}

console.log('Build complete! Load dist/ as unpacked extension in Chrome.');
