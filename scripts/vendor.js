#!/usr/bin/env node
/**
 * vendor.js — copy the browser-only libraries (Three.js + addons) into
 * public/vendor so the server works with no internet access at run time.
 * Three.js is deliberately NOT a package.json dependency: it is only ever
 * served to the browser from public/vendor.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = path.join(ROOT, 'node_modules', 'three');
const dst = path.join(ROOT, 'public', 'vendor', 'three');

if (!fs.existsSync(src)) {
  console.log('three is not installed in node_modules — skipping vendoring.');
  console.log('Run:  npm install --no-save three@0.169.0   then   node scripts/vendor.js');
  process.exit(0);
}

const copies = [
  ['build/three.module.js', 'three.module.js'],
  ['examples/jsm/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],
];

for (const [from, to] of copies) {
  const f = path.join(src, from);
  const t = path.join(dst, to);
  if (!fs.existsSync(f)) { console.warn('missing', from); continue; }
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.copyFileSync(f, t);
  console.log('vendored', to);
}
console.log('Three.js vendored into public/vendor/three');
