import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSitemap, processSitemap, buildFiles, renderIndex, chunk, transformLastmod, pathInfo, normalizeConfig, parseEnv,
} from '../src/lib.mjs';

const cfg = {
  defaultLocale: 'en',
  locales: ['nl', 'de'],
  exclude: ['^thank-you', '^dev/'],
  splitBy: 'locale',
  groups: [{ name: 'blogs', pattern: '^blogs(/|$)' }],
  lastmod: 'keep',
  priorityRules: [],
  extraUrls: [],
};

const alt = (loc) =>
  `    <xhtml:link rel="alternate" hreflang="x" href="${loc}"/>`;

const url = (loc, lastmod, alts = []) =>
  `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n${alts.map(alt).join('\n')}\n  </url>`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${url('https://example.com', '2026-07-23T10:00:00.000Z', ['https://example.com', 'https://example.com/nl'])}
${url('https://example.com/nl', '2026-07-24T10:00:00.000Z', ['https://example.com', 'https://example.com/nl'])}
${url('https://example.com/blogs/a', '2026-08-01T10:00:00.000Z', ['https://example.com/blogs/a', 'https://example.com/nl/blogs/a'])}
${url('https://example.com/nl/blogs/a', '2026-08-02T10:00:00.000Z', ['https://example.com/blogs/a', 'https://example.com/nl/blogs/a'])}
${url('https://example.com/thank-you-sales', '2026-07-23T10:00:00.000Z', ['https://example.com/thank-you-sales', 'https://example.com/nl/thank-you-sales'])}
${url('https://example.com/nl/thank-you-sales', '2026-07-23T10:00:00.000Z', ['https://example.com/thank-you-sales', 'https://example.com/nl/thank-you-sales'])}
${url('https://example.com/dev/test-hubspot', '2026-07-23T10:00:00.000Z')}
</urlset>`;

test('parseSitemap membaca loc, lastmod, dan hreflang', () => {
  const urls = parseSitemap(XML);
  assert.equal(urls.length, 7);
  assert.equal(urls[0].loc, 'https://example.com');
  assert.equal(urls[0].lastmod, '2026-07-23T10:00:00.000Z');
  assert.equal(urls[0].links.length, 2);
});

test('parseSitemap menolak sitemap index', () => {
  assert.throws(() => parseSitemap('<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>'));
});

test('pathInfo memisahkan prefix bahasa', () => {
  assert.deepEqual(pathInfo('https://example.com/de/blogs/x', cfg), { locale: 'de', path: 'blogs/x' });
  assert.deepEqual(pathInfo('https://example.com/blogs/x', cfg), { locale: 'en', path: 'blogs/x' });
  assert.deepEqual(pathInfo('https://example.com', cfg), { locale: 'en', path: '' });
});

test('exclude membuang URL di semua bahasa', () => {
  const { groups, excludedCount } = processSitemap(parseSitemap(XML), cfg);
  const locs = [...groups.values()].flat().map((u) => u.loc);
  assert.equal(excludedCount, 3);
  assert.equal(locs.length, 4);
  assert.ok(!locs.some((l) => l.includes('thank-you') || l.includes('/dev/')));
});

test('hreflang ke URL yang dibuang ikut dibersihkan', () => {
  const xml = `<urlset>${url('https://example.com/blogs/a', '2026-08-01', ['https://example.com/blogs/a', 'https://example.com/thank-you-sales'])}</urlset>`;
  const { groups } = processSitemap(parseSitemap(xml), {
    ...cfg,
    exclude: ['^thank-you'],
    extraUrls: [{ loc: 'https://example.com/thank-you-sales' }],
  });
  const u = [...groups.values()].flat()[0];
  assert.equal(u.links.length, 1);
  assert.match(u.links[0], /blogs\/a/);
});

test('splitBy locale mengelompokkan per bahasa', () => {
  const { groups } = processSitemap(parseSitemap(XML), cfg);
  assert.deepEqual([...groups.keys()].sort(), ['en', 'nl']);
  assert.equal(groups.get('en').length, 2);
  assert.equal(groups.get('nl').length, 2);
});

test('splitBy type mengelompokkan per tipe', () => {
  const { groups } = processSitemap(parseSitemap(XML), { ...cfg, splitBy: 'type' });
  assert.equal(groups.get('blogs').length, 2);
  assert.equal(groups.get('pages').length, 2);
});

test('splitBy none menghasilkan satu kelompok', () => {
  const { groups } = processSitemap(parseSitemap(XML), { ...cfg, splitBy: 'none' });
  assert.deepEqual([...groups.keys()], ['all']);
});

test('mode lastmod', () => {
  assert.equal(transformLastmod('2026-07-23T10:00:00.000Z', 'keep'), '2026-07-23T10:00:00.000Z');
  assert.equal(transformLastmod('2026-07-23T10:00:00.000Z', 'date'), '2026-07-23');
  assert.equal(transformLastmod('2026-07-23T10:00:00.000Z', 'remove'), null);
});

test('priorityRules menambahkan priority dan changefreq', () => {
  const { groups } = processSitemap(parseSitemap(XML), {
    ...cfg,
    priorityRules: [{ pattern: '^$', priority: '1.0', changefreq: 'daily' }],
  });
  const home = groups.get('en').find((u) => u.loc === 'https://example.com');
  assert.equal(home.priority, '1.0');
  assert.equal(home.changefreq, 'daily');
});

test('extraUrls ditambahkan dan di-escape', () => {
  const { groups } = processSitemap(parseSitemap(XML), {
    ...cfg,
    extraUrls: [{ loc: 'https://example.com/app/?a=1&b=2' }],
  });
  const locs = [...groups.values()].flat().map((u) => u.loc);
  assert.ok(locs.includes('https://example.com/app/?a=1&amp;b=2'));
});

test('buildFiles dan renderIndex menghasilkan XML yang konsisten', () => {
  const { groups } = processSitemap(parseSitemap(XML), cfg);
  const files = buildFiles(groups, cfg);
  assert.deepEqual(files.map((f) => f.name), ['sitemap-en.xml', 'sitemap-nl.xml']);
  assert.equal(files[1].lastmod, '2026-08-02T10:00:00.000Z');
  const index = renderIndex(files.map((f) => ({ loc: `https://x.test/${f.name}`, lastmod: f.lastmod })));
  assert.match(index, /<sitemapindex/);
  assert.match(index, /https:\/\/x\.test\/sitemap-nl\.xml/);
});

test('chunk memecah daftar besar', () => {
  assert.equal(chunk([1, 2, 3, 4, 5], 2).length, 3);
  assert.equal(chunk([], 2).length, 1);
});

// ---- locale+type, pageSize, validasi ----

const many = (locale, type, n, start = 0) =>
  Array.from({ length: n }, (_, i) => {
    const p = `${type}/item-${String(start + i).padStart(4, '0')}`;
    return { loc: `https://example.com/${locale === 'en' ? '' : locale + '/'}${p}`, lastmod: '2026-01-01', links: [] };
  });

const cfg2 = {
  ...cfg,
  locales: ['nl', 'de'],
  splitBy: 'locale+type',
  pageSize: 100,
  groups: [
    { name: 'knowledge', pattern: '^knowledge(/|$)' },
    { name: 'blogs', pattern: '^blogs(/|$)' },
  ],
  defaultGroup: 'pages',
};

test('locale+type mengelompokkan per bahasa lalu tipe', () => {
  const { groups } = processSitemap(parseSitemap(XML), cfg2);
  assert.deepEqual([...groups.keys()].sort(), ['en/blogs', 'en/pages', 'nl/blogs', 'nl/pages']);
  assert.equal(groups.get('nl/blogs').length, 1);
});

test('pemecahan per pageSize: 250 URL, pageSize 100 -> 100/100/50', () => {
  const { groups } = processSitemap(many('de', 'knowledge', 250), cfg2);
  const files = buildFiles(groups, cfg2);
  assert.deepEqual(files.map((f) => f.name), [
    'sitemap-de-knowledge-1.xml', 'sitemap-de-knowledge-2.xml', 'sitemap-de-knowledge-3.xml',
  ]);
  assert.deepEqual(files.map((f) => f.count), [100, 100, 50]);
});

test('override pageSize per grup', () => {
  const c = { ...cfg2, groups: [{ name: 'knowledge', pattern: '^knowledge', pageSize: 50 }, { name: 'blogs', pattern: '^blogs' }] };
  const { groups } = processSitemap([...many('de', 'knowledge', 120), ...many('de', 'blogs', 120)], c);
  const files = buildFiles(groups, c);
  assert.deepEqual(files.filter((f) => f.name.includes('knowledge')).map((f) => f.count), [50, 50, 20]);
  assert.deepEqual(files.filter((f) => f.name.includes('blogs')).map((f) => f.count), [100, 20]);
});

test('pageSize efektif dibatasi 45000', () => {
  assert.equal(normalizeConfig({ ...cfg2, pageSize: 99999 }).pageSize, 45000);
});

test('nama file selalu bernomor dan urutan file mengikuti locale, grup, halaman', () => {
  const urls = [
    ...many('de', 'blogs', 1), ...many('en', 'misc', 1), ...many('nl', 'knowledge', 150),
    ...many('en', 'blogs', 1), ...many('de', 'knowledge', 1),
  ];
  const { groups } = processSitemap(urls, cfg2);
  const names = buildFiles(groups, cfg2).map((f) => f.name);
  assert.deepEqual(names, [
    'sitemap-en-blogs-1.xml', 'sitemap-en-pages-1.xml',
    'sitemap-nl-knowledge-1.xml', 'sitemap-nl-knowledge-2.xml',
    'sitemap-de-knowledge-1.xml', 'sitemap-de-blogs-1.xml',
  ]);
});

test('urutan URL deterministik berdasarkan path, apa pun urutan sumber', () => {
  const urls = many('de', 'knowledge', 30);
  const a = buildFiles(processSitemap(urls, cfg2).groups, cfg2);
  const b = buildFiles(processSitemap([...urls].reverse(), cfg2).groups, cfg2);
  assert.deepEqual(a.map((f) => f.xml), b.map((f) => f.xml));
  const locs = [...a[0].xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [...locs].sort());
});

test('mode lama tetap berfungsi dan pageSize berlaku di semua mode', () => {
  const urls = many('de', 'knowledge', 250);
  for (const splitBy of ['locale', 'type', 'none']) {
    const c = { ...cfg2, splitBy };
    const files = buildFiles(processSitemap(urls, c).groups, c);
    assert.deepEqual(files.map((f) => f.count), [100, 100, 50], splitBy);
  }
  const c = { ...cfg2, splitBy: 'locale' };
  assert.match(buildFiles(processSitemap(urls, c).groups, c)[0].name, /^sitemap-de-1\.xml$/);
});

test('validasi config', () => {
  assert.throws(() => normalizeConfig({ ...cfg2, pageSize: 0 }), /pageSize harus bilangan bulat positif/);
  assert.throws(() => normalizeConfig({ ...cfg2, pageSize: 1.5 }), /pageSize/);
  assert.throws(
    () => normalizeConfig({ ...cfg2, groups: [{ name: 'a', pattern: 'x' }, { name: 'a', pattern: 'y' }] }),
    /duplikat/
  );
  assert.throws(() => normalizeConfig({ ...cfg2, groups: [{ name: 'a', pattern: '(' }] }), /regex tidak valid/);
  assert.throws(() => normalizeConfig({ ...cfg2, groups: [{ name: 'Bad Name', pattern: 'x' }] }), /tidak aman/);
  assert.throws(() => normalizeConfig({ ...cfg2, groups: [{ name: 'pages', pattern: 'x' }] }), /defaultGroup/);
  assert.throws(() => normalizeConfig({ ...cfg2, groups: [{ name: 'a', pattern: 'x', pageSize: -1 }] }), /pageSize grup/);
  assert.throws(() => normalizeConfig({ ...cfg2, splitBy: 'foo' }), /splitBy/);
  assert.throws(() => normalizeConfig({ ...cfg2, typeGroups: {} }), /typeGroups/);
});

test('grup tanpa URL memicu peringatan, grup yang cocok tidak', () => {
  const c = { ...cfg2, groups: [...cfg2.groups, { name: 'kosong', pattern: '^tidak-ada' }] };
  const { warnings } = processSitemap(parseSitemap(XML), c);
  // XML contoh tidak punya URL knowledge maupun "kosong", tetapi punya blogs.
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes('"kosong"')));
  assert.ok(!warnings.some((w) => w.includes('"blogs"')));
});

test('parseEnv membaca KEY=VALUE, kutip, komentar, export', () => {
  const e = parseEnv('# komentar\nSOURCE_URL=https://a.test/sitemap.xml # catatan\nexport B="x y"\nC=\'z\'\n\nbaris rusak\n');
  assert.deepEqual(e, { SOURCE_URL: 'https://a.test/sitemap.xml', B: 'x y', C: 'z' });
});
