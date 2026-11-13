// Fungsi murni untuk memproses sitemap. Tanpa dependensi, mudah diuji.

export const NS_SITEMAP = 'http://www.sitemaps.org/schemas/sitemap/0.9';
export const NS_XHTML = 'http://www.w3.org/1999/xhtml';
export const MAX_URLS_PER_FILE = 45000; // batas protokol 50.000, sisakan ruang

const tag = (s, t) => {
  const m = s.match(new RegExp(`<${t}>\\s*([\\s\\S]*?)\\s*</${t}>`));
  return m ? m[1].trim() : null;
};

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Parse urlset. Nilai disimpan apa adanya (sudah ter-escape dari sumber). */
export function parseSitemap(xml) {
  if (/<sitemapindex[\s>]/.test(xml)) {
    throw new Error('Sumber berupa sitemap index, bukan urlset. Sesuaikan sourceUrl.');
  }
  const urls = [];
  const re = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const loc = tag(body, 'loc');
    if (!loc) continue;
    urls.push({
      loc,
      lastmod: tag(body, 'lastmod'),
      links: [...body.matchAll(/<xhtml:link\b[^>]*?\/>/g)].map((x) => x[0]),
    });
  }
  return urls;
}

/** Pisahkan prefix bahasa dari path. "/de/blogs/x" -> { locale: "de", path: "blogs/x" } */
export function pathInfo(loc, cfg) {
  let pathname;
  try {
    pathname = new URL(loc).pathname;
  } catch {
    pathname = loc;
  }
  const segs = pathname.split('/').filter(Boolean);
  const locales = (cfg.locales || []).map((l) => l.toLowerCase());
  if (segs.length && locales.includes(segs[0].toLowerCase())) {
    return { locale: segs[0].toLowerCase(), path: segs.slice(1).join('/') };
  }
  return { locale: cfg.defaultLocale || 'default', path: segs.join('/') };
}

export function transformLastmod(value, mode = 'keep') {
  if (!value || mode === 'remove') return null;
  if (mode === 'date') return value.slice(0, 10);
  return value;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const SPLIT_MODES = ['locale+type', 'locale', 'type', 'none'];

/** Validasi config pengelompokan dan hasilkan bentuk yang siap pakai. Error berbahasa Indonesia. */
export function normalizeConfig(cfg) {
  const splitBy = cfg.splitBy ?? 'locale';
  if (!SPLIT_MODES.includes(splitBy)) {
    throw new Error(`splitBy "${splitBy}" tidak dikenal. Pilih salah satu: ${SPLIT_MODES.join(', ')}.`);
  }
  if ('typeGroups' in cfg) {
    throw new Error('Kunci "typeGroups" sudah diganti dengan array "groups": [{ "name": "...", "pattern": "..." }].');
  }
  const validSize = (v, label) => {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${label} harus bilangan bulat positif, bukan ${JSON.stringify(v)}.`);
    return Math.min(v, MAX_URLS_PER_FILE);
  };
  const pageSize = cfg.pageSize === undefined ? MAX_URLS_PER_FILE : validSize(cfg.pageSize, 'pageSize');

  const defaultGroup = cfg.defaultGroup ?? 'pages';
  if (typeof defaultGroup !== 'string' || !defaultGroup || slug(defaultGroup) !== defaultGroup) {
    throw new Error(`defaultGroup "${defaultGroup}" tidak aman untuk nama file. Pakai huruf kecil, angka, dan tanda hubung, misalnya "${slug(defaultGroup) || 'pages'}".`);
  }

  if (cfg.groups !== undefined && !Array.isArray(cfg.groups)) {
    throw new Error('groups harus berupa array: [{ "name": "...", "pattern": "..." }].');
  }
  const seen = new Set();
  const groups = (cfg.groups || []).map((g, i) => {
    const name = g?.name;
    if (typeof name !== 'string' || !name) throw new Error(`groups[${i}]: "name" wajib diisi.`);
    if (slug(name) !== name) {
      throw new Error(`Nama grup "${name}" tidak aman untuk nama file. Pakai huruf kecil, angka, dan tanda hubung, misalnya "${slug(name)}".`);
    }
    if (name === defaultGroup) throw new Error(`Nama grup "${name}" tidak boleh sama dengan defaultGroup.`);
    if (seen.has(name)) throw new Error(`Nama grup "${name}" duplikat. Nama grup harus unik.`);
    seen.add(name);
    if (typeof g.pattern !== 'string') throw new Error(`Grup "${name}": "pattern" wajib berupa string regex.`);
    let re;
    try {
      re = new RegExp(g.pattern);
    } catch (e) {
      throw new Error(`Grup "${name}": regex tidak valid (${g.pattern}): ${e.message}`);
    }
    const size = g.pageSize === undefined ? pageSize : validSize(g.pageSize, `pageSize grup "${name}"`);
    return { name, pattern: g.pattern, re, pageSize: size };
  });
  return {
    splitBy,
    pageSize,
    defaultGroup,
    groups,
    usesGroups: splitBy === 'type' || splitBy === 'locale+type' || (splitBy === 'locale' && groups.length > 0),
  };
}

/**
 * Terapkan aturan: exclude, tambah URL ekstra, bersihkan hreflang yang menunjuk
 * ke URL yang dibuang, atur lastmod/priority/changefreq, lalu kelompokkan.
 */
export function processSitemap(sourceUrls, cfg) {
  const norm = normalizeConfig(cfg);
  const excludeRes = (cfg.exclude || []).map((p) => new RegExp(p));
  const prioRules = (cfg.priorityRules || []).map((r) => ({ ...r, re: new RegExp(r.pattern) }));
  const matched = new Set();
  // Mode locale + groups: satu file per bahasa, URL diurutkan per grup dan diberi komentar pemisah.
  const groupedInLocale = norm.splitBy === 'locale' && norm.groups.length > 0;
  const groupRank = (name) => {
    const i = norm.groups.findIndex((g) => g.name === name);
    return i === -1 ? norm.groups.length : i;
  };
  const groupOf = (path) => {
    const hit = norm.groups.find((g) => g.re.test(path));
    if (hit) matched.add(hit.name);
    return hit ? hit.name : norm.defaultGroup;
  };

  const extra = (cfg.extraUrls || []).map((e) => {
    if (!/^https:\/\//.test(e.loc)) throw new Error(`extraUrls harus berawalan https://: ${e.loc}`);
    return { loc: escapeXml(e.loc), lastmod: e.lastmod || null, links: [] };
  });

  const all = [...sourceUrls, ...extra];
  const excluded = new Set();
  const kept = [];
  for (const u of all) {
    const { path } = pathInfo(u.loc, cfg);
    if (excludeRes.some((r) => r.test(path))) excluded.add(u.loc);
    else kept.push(u);
  }

  const groups = new Map();
  for (const u of kept) {
    const { locale, path } = pathInfo(u.loc, cfg);
    let g;
    if (norm.splitBy === 'locale+type') g = `${locale}/${groupOf(path)}`;
    else if (norm.splitBy === 'type') g = groupOf(path);
    else if (norm.splitBy === 'locale') g = locale;
    else g = 'all';

    const rule = prioRules.find((r) => r.re.test(path));
    const out = {
      loc: u.loc,
      lastmod: transformLastmod(u.lastmod, cfg.lastmod || 'keep'),
      changefreq: rule?.changefreq || null,
      priority: rule?.priority || null,
      links: u.links.filter((l) => {
        const h = /href="([^"]*)"/.exec(l);
        return !(h && excluded.has(h[1]));
      }),
      path,
    };
    if (groupedInLocale) {
      out.group = groupOf(path);
      out.gi = groupRank(out.group);
    }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(out);
  }
  // Urutan deterministik: path (tanpa prefix bahasa) menaik, lalu loc sebagai pemutus seri.
  for (const list of groups.values()) list.sort((a, b) => (a.gi ?? 0) - (b.gi ?? 0) || cmp(a.path, b.path) || cmp(a.loc, b.loc));
  for (const list of groups.values()) for (const u of list) { delete u.path; delete u.gi; }

  const warnings = [];
  if (norm.usesGroups) {
    for (const g of norm.groups) {
      if (!matched.has(g.name)) warnings.push(`Grup "${g.name}" tidak cocok dengan URL mana pun (pattern: ${g.pattern}).`);
    }
  }
  return { groups, excludedCount: excluded.size, warnings };
}

export function renderUrl(u) {
  const lines = ['  <url>', `    <loc>${u.loc}</loc>`];
  if (u.lastmod) lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
  if (u.changefreq) lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
  if (u.priority) lines.push(`    <priority>${u.priority}</priority>`);
  for (const l of u.links) lines.push(`    ${l}`);
  lines.push('  </url>');
  return lines.join('\n');
}

export function renderUrlset(urls) {
  // Komentar pemisah grup hanya muncul bila URL membawa properti group (mode locale + groups).
  let last;
  const body = urls.map((u) => {
    const head = u.group && u.group !== last ? `  <!-- ${u.group} -->\n` : '';
    last = u.group;
    return head + renderUrl(u);
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="${NS_SITEMAP}" xmlns:xhtml="${NS_XHTML}">\n` +
    body.join('\n') +
    `\n</urlset>\n`
  );
}

export function renderIndex(entries) {
  const body = entries
    .map((e) => {
      const lm = e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : '';
      return `  <sitemap>\n    <loc>${e.loc}</loc>${lm}\n  </sitemap>`;
    })
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="${NS_SITEMAP}">\n${body}\n</sitemapindex>\n`
  );
}

export function chunk(arr, size = MAX_URLS_PER_FILE) {
  size = Math.min(size, MAX_URLS_PER_FILE);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Ubah groups menjadi daftar file {name, group, xml, count, lastmod}, berurutan:
 * locale (default dulu, lalu config.locales), grup (urutan config, default terakhir), nomor halaman.
 * Mode locale+type: sitemap-<locale>-<grup>-<n>.xml, selalu bernomor.
 * Mode lama (locale/type/none): bernomor hanya bila lebih dari satu halaman.
 */
export function buildFiles(groups, cfg = {}) {
  const norm = normalizeConfig(cfg);
  const localeOrder = [cfg.defaultLocale, ...(cfg.locales || [])].filter(Boolean).map((l) => l.toLowerCase());
  const groupOrder = [...norm.groups.map((g) => g.name), norm.defaultGroup];
  const rank = (list, v) => {
    const i = list.indexOf(v);
    return i === -1 ? list.length : i;
  };
  const sizeOf = (group) => norm.groups.find((g) => g.name === group)?.pageSize ?? norm.pageSize;

  const entries = [...groups.entries()].map(([key, list]) => {
    if (norm.splitBy === 'locale+type') {
      const [locale, group] = key.split('/');
      return { key, list, locale, group };
    }
    if (norm.splitBy === 'locale') return { key, list, locale: key, group: '' };
    if (norm.splitBy === 'type') return { key, list, locale: '', group: key };
    return { key, list, locale: '', group: key };
  });
  entries.sort(
    (a, b) =>
      rank(localeOrder, a.locale) - rank(localeOrder, b.locale) ||
      cmp(a.locale, b.locale) ||
      rank(groupOrder, a.group) - rank(groupOrder, b.group) ||
      cmp(a.group, b.group)
  );

  const files = [];
  for (const e of entries) {
    const parts = chunk(e.list, sizeOf(e.group));
    parts.forEach((part, i) => {
      const n = i + 1;
      const base = norm.splitBy === 'locale+type' ? `${slug(e.locale)}-${slug(e.group)}` : slug(e.key);
      const suffix = norm.splitBy === 'locale+type' ? `-${n}` : parts.length > 1 ? `-${n}` : '';
      const lastmods = part.map((u) => u.lastmod).filter(Boolean).sort();
      files.push({
        name: `sitemap-${base}${suffix}.xml`,
        group: e.key,
        xml: renderUrlset(part),
        count: part.length,
        lastmod: lastmods.length ? lastmods[lastmods.length - 1] : null,
      });
    });
  }
  return files;
}

/** Parse isi file .env: KEY=VALUE, komentar #, "export " opsional, nilai boleh diberi tanda kutip. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
