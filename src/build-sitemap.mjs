#!/usr/bin/env node
// Unduh sitemap Webflow, terapkan aturan di config/rules.json, tulis hasilnya ke docs/.
//
// Pemakaian:
//   node src/build-sitemap.mjs
//   node src/build-sitemap.mjs --source https://staging.example.com/sitemap.xml   (atau SOURCE_URL di .env)
//   node src/build-sitemap.mjs --input sitemap.xml --out out --allow-placeholder   (uji lokal)

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, parseSitemap, processSitemap, buildFiles, renderIndex } from './lib.mjs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-placeholder') a.allowPlaceholder = true;
    else if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

const args = parseArgs(process.argv.slice(2));

// Muat .env (bila ada) tanpa menimpa variabel yang sudah diset di environment.
try {
  const env = parseEnv(await fs.readFile(args.env ?? '.env', 'utf8'));
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
} catch (e) {
  if (e.code !== 'ENOENT' || args.env) throw e;
}
const cfg = await readJson(args.config ?? 'config/rules.json');
const outDir = args.out ?? 'docs';

if (/YOUR-/i.test(cfg.publicBaseUrl) && !args.allowPlaceholder) {
  console.error('publicBaseUrl di config/rules.json masih placeholder. Isi dengan alamat hosting sitemap Anda.');
  process.exit(1);
}
const base = cfg.publicBaseUrl.replace(/\/+$/, '');

// 1. Ambil sumber. Prioritas URL: --source, lalu SOURCE_URL (env/.env), lalu sourceUrl di config.
const sourceUrl = args.source || process.env.SOURCE_URL || cfg.sourceUrl;
if (!args.input && /YOUR-/i.test(sourceUrl || '') && !args.allowPlaceholder) {
  console.error('sourceUrl masih placeholder. Isi di config/rules.json, atau set SOURCE_URL di .env / --source.');
  process.exit(1);
}
if (!args.input && !/^https?:\/\/\S+$/.test(sourceUrl || '')) {
  console.error(`sourceUrl tidak valid: ${JSON.stringify(sourceUrl)}. Harus berawalan http:// atau https://.`);
  process.exit(1);
}
let xml;
if (args.input) {
  xml = await fs.readFile(args.input, 'utf8');
} else {
  const res = await fetch(sourceUrl, { headers: { 'user-agent': 'webflow-sitemap-builder/1.0' } });
  if (!res.ok) {
    console.error(`Gagal mengunduh ${sourceUrl}: HTTP ${res.status}`);
    process.exit(1);
  }
  xml = await res.text();
}

const sourceUrls = parseSitemap(xml);
if (sourceUrls.length === 0) {
  console.error('Sumber tidak berisi URL. Dibatalkan agar sitemap lama tidak tertimpa kosong.');
  process.exit(1);
}

// 2. Pengaman: batalkan bila jumlah URL sumber turun drastis dibanding run sebelumnya
const statsPath = path.join(outDir, 'stats.json');
const prev = await readJson(statsPath, null);
const maxDrop = cfg.maxDropPercent ?? 30;
if (prev?.sourceUrls && !process.env.FORCE) {
  const floor = prev.sourceUrls * (1 - maxDrop / 100);
  if (sourceUrls.length < floor) {
    console.error(
      `Jumlah URL sumber turun dari ${prev.sourceUrls} ke ${sourceUrls.length} (batas turun ${maxDrop}%). ` +
        `Dibatalkan. Jika memang disengaja, jalankan ulang dengan FORCE=1.`
    );
    process.exit(1);
  }
}

// 3. Proses
const { groups, excludedCount, warnings } = processSitemap(sourceUrls, cfg);
for (const w of warnings) console.warn(`PERINGATAN: ${w}`);
const files = buildFiles(groups, cfg);
const outputUrls = files.reduce((n, f) => n + f.count, 0);
if (outputUrls === 0) {
  console.error('Hasil akhir kosong. Periksa aturan exclude. Dibatalkan.');
  process.exit(1);
}

// 4. Tulis (hapus sitemap-*.xml lama agar tidak ada file usang)
await fs.mkdir(outDir, { recursive: true });
for (const f of await fs.readdir(outDir)) {
  if (/^sitemap-.*\.xml$/.test(f)) await fs.rm(path.join(outDir, f));
}
for (const f of files) await fs.writeFile(path.join(outDir, f.name), f.xml);

const index = renderIndex(files.map((f) => ({ loc: `${base}/${f.name}`, lastmod: f.lastmod })));
await fs.writeFile(path.join(outDir, 'sitemap-index.xml'), index);
await fs.writeFile(path.join(outDir, '.nojekyll'), '');

// stats.json sengaja tanpa timestamp supaya tidak ada commit bila hasil tidak berubah
const stats = {
  sourceUrls: sourceUrls.length,
  excludedUrls: excludedCount,
  outputUrls,
  files: Object.fromEntries(files.map((f) => [f.name, f.count])),
  groups: {},
};
for (const f of files) {
  const g = (stats.groups[f.group] ??= { urls: 0, files: 0 });
  g.urls += f.count;
  g.files += 1;
}
await fs.writeFile(statsPath, JSON.stringify(stats, null, 2) + '\n');

console.log(`Sumber: ${stats.sourceUrls} URL | dibuang: ${stats.excludedUrls} | hasil: ${stats.outputUrls} URL`);
for (const [n, c] of Object.entries(stats.files)) console.log(`  ${n}: ${c}`);
console.log(`Index: ${base}/sitemap-index.xml`);
