# webflow-sitemap-builder

Mengubah sitemap otomatis Webflow (`https://example.com/sitemap.xml`) sesuai aturan tim SEO, lalu menerbitkannya di GitHub Pages. Berjalan otomatis tiap jam lewat GitHub Actions. Tidak butuh server atau akses DNS.

```
Webflow  →  /sitemap.xml (tetap otomatis)
              ↓  GitHub Actions (tiap jam)
        src/build-sitemap.mjs  +  config/rules.json
              ↓
        docs/sitemap-index.xml, docs/sitemap-<bahasa>-<grup>-<n>.xml   (GitHub Pages)
              ↓
        robots.txt Webflow → "Sitemap: https://<user>.github.io/<repo>/sitemap-index.xml"
```

## Yang dilakukan script

- Mengunduh sitemap Webflow dan memeriksa hasilnya (tidak boleh kosong; tidak boleh turun drastis dari run sebelumnya).
- Membuang URL sesuai pola `exclude`. Tag hreflang yang menunjuk ke URL yang dibuang ikut dibersihkan dari URL lain.
- Mengatur `lastmod`, `priority`, `changefreq` sesuai config.
- Menambah URL ekstra bila ada.
- Mengelompokkan hasil per bahasa lalu per tipe konten, memecah tiap kelompok per `pageSize` URL, dan membuat satu `sitemap-index.xml` datar.
- Hreflang dari sumber dipertahankan apa adanya.

Bawaan config saat ini (**contoh, sesuaikan dengan kebutuhan situs Anda**): buang halaman `thank-you*` dan `dev/*`, kelompokkan per bahasa + tipe konten (100 URL per file), `lastmod` dipertahankan. Contoh pada sitemap berisi 2.991 URL: 2.775 URL tersisa (216 dibuang).

## Setup

### 1. Buat repositori GitHub
Buat repositori baru (misalnya `webflow-sitemap`) lalu unggah isi folder ini. Gunakan repositori **publik** bila memakai GitHub Pages gratis. Isinya hanya script dan sitemap yang memang publik.

### 2. Isi `config/rules.json`
Ganti `sourceUrl` dengan sitemap Webflow Anda (`https://DOMAIN-ANDA/sitemap.xml`), dan `publicBaseUrl` dengan alamat Pages Anda, tanpa garis miring di akhir:

```json
"publicBaseUrl": "https://NAMA-USER.github.io/webflow-sitemap"
```

Selama masih berisi `YOUR-`, script menolak berjalan agar tidak menerbitkan index dengan alamat salah.

### 3. Aktifkan GitHub Pages
Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** → Branch: `main`, folder `/docs`.

### 4. Jalankan workflow pertama kali
Tab **Actions** → *Build sitemap* → **Run workflow**. Setelah selesai, buka `https://NAMA-USER.github.io/webflow-sitemap/sitemap-index.xml` dan pastikan terbaca.

Jika workflow gagal saat push, periksa Settings → Actions → General → *Workflow permissions* dan pilih **Read and write permissions**.

### 5. Arahkan robots.txt di Webflow
Site settings → SEO → Indexing:

1. Aktifkan **Remove sitemap.xml from robots.txt**.
2. Di kolom robots.txt, tulis:

```
User-agent: *
Allow: /

Sitemap: https://NAMA-USER.github.io/webflow-sitemap/sitemap-index.xml
```

3. Hapus tujuh baris `Sitemap:` per bahasa (`/en-us/sitemap.xml`, dst.) karena semuanya 404.
4. **Publish** site, lalu cek `https://example.com/robots.txt`.

Jangan matikan *Auto-generate sitemap* di Webflow. File itu adalah sumber data script.

### 6. Search Console
- Hapus sitemap lama (`/sitemap.xml`) dari daftar Sitemaps bila pernah disubmit.
- Submit `sitemap-index.xml` baru pada properti example.com.
- Pantau laporan Sitemaps beberapa hari. Untuk sitemap di domain lain, laporan kadang tidak seragam. Pastikan URL terbaca dan tidak ada error.

## Konfigurasi (`config/rules.json`)

| Kunci | Fungsi |
|---|---|
| `sourceUrl` | Sitemap Webflow yang diunduh. Bisa ditimpa lewat `--source <url>`, atau `SOURCE_URL` di environment / file `.env` (salin dari `.env.example`; `.env` masuk `.gitignore`). Prioritas: `--source`, `SOURCE_URL`, lalu config. Variabel environment yang sudah diset menang atas isi `.env`; lokasi file bisa diganti dengan `--env <file>`. `--input <file>` mengalahkan semuanya. |
| `publicBaseUrl` | Alamat publik folder `docs/`, dipakai untuk `<loc>` di sitemap index. |
| `defaultLocale`, `locales` | Bahasa default (tanpa prefix di URL) dan daftar prefix bahasa lain. |
| `exclude` | Daftar regex. Dicocokkan ke path **tanpa prefix bahasa**, misalnya `thank-you-sales` atau `blogs/judul`. Contoh: `"^landing/"` membuang semua halaman landing. |
| `splitBy` | `locale+type` (bahasa, lalu tipe konten di dalamnya; bawaan yang disarankan), `locale` (satu kelompok per bahasa), `type` (per tipe konten, semua bahasa digabung), atau `none` (satu kelompok). |
| `groups` | Array berurutan `{ "name": "knowledge", "pattern": "^knowledge(/|$)" }`; aturan pertama yang cocok menang. `pattern` dicocokkan ke path **tanpa prefix bahasa**. Dipakai bila `splitBy` = `type` atau `locale+type`. `name` harus unik, huruf kecil/angka/tanda hubung (dipakai di nama file), dan tidak boleh sama dengan `defaultGroup`. |
| `defaultGroup` | Nama grup untuk URL yang tidak cocok dengan aturan mana pun (bawaan `pages`). Selalu di urutan terakhir. |
| `pageSize` | Jumlah URL maksimum per file, berlaku di semua mode `splitBy`. Bilangan bulat positif; efektifnya `min(pageSize, 45000)`. Tanpa `pageSize`, batas 45.000 dipakai. |
| `groups[].pageSize` | Opsional, menimpa `pageSize` global untuk satu grup, misalnya `{ "name": "knowledge", "pattern": "...", "pageSize": 50 }`. |
| `lastmod` | `keep` (apa adanya), `date` (hanya tanggal), atau `remove` (hapus). |
| `priorityRules` | Daftar `{ "pattern": "regex", "priority": "0.8", "changefreq": "weekly" }`, aturan pertama yang cocok dipakai. Kosong = tidak ditambahkan. Google menyatakan mengabaikan keduanya. |
| `extraUrls` | Daftar `{ "loc": "https://example.com/app/", "lastmod": "2026-01-01" }` untuk URL di luar Webflow. |
| `maxDropPercent` | Batalkan run bila jumlah URL sumber turun lebih dari persentase ini dibanding run sebelumnya (bawaan 30). |

Config divalidasi saat dijalankan; kesalahan (pageSize bukan bilangan bulat positif, nama grup duplikat atau tidak aman, regex tidak valid) menghentikan script dengan pesan jelas. Grup yang tidak cocok dengan URL mana pun hanya memunculkan peringatan. Kunci lama `typeGroups` sudah diganti `groups` dan akan ditolak.

Perubahan config otomatis berlaku pada run berikutnya. Untuk langsung, jalankan workflow manual.

### Struktur file hasil (`splitBy: "locale+type"`)

Nama file: `sitemap-<bahasa>-<grup>-<n>.xml`, `n` mulai dari 1 dan **selalu ada** walau hanya satu halaman, supaya nama file stabil saat jumlah URL naik-turun. Bahasa default (tanpa prefix di URL) memakai nama `defaultLocale`, yaitu `en`.

```
docs/
  sitemap-index.xml                          ← satu index datar
  sitemap-en-knowledge-1.xml                 (100 URL)
  sitemap-en-knowledge-2.xml                 (98 URL)
  sitemap-en-blogs-1.xml
  sitemap-en-instructions-manuals-1.xml
  sitemap-en-products-1.xml
  sitemap-en-pages-1.xml
  sitemap-nl-knowledge-1.xml                 ← lalu nl, en-us, en-gb, de, es, fr, pt
  ...
  stats.json
```

Urutan di index: bahasa sesuai config (default dulu, lalu `locales`), lalu grup sesuai urutan `groups` (`defaultGroup` terakhir), lalu nomor halaman. `lastmod` tiap entri index adalah `lastmod` terbaru di file itu.

**Kenapa index datar?** Protokol sitemap melarang sitemap index menunjuk sitemap index lain, jadi tidak bisa dibuat index per bahasa yang berisi file per tipe. Semua file didaftar langsung di satu `sitemap-index.xml` (batas index 50.000 file, jauh di atas kebutuhan).

Mode lama (`locale`, `type`, `none`) tetap memakai penamaan lama: `sitemap-<kelompok>.xml`, dan baru diberi nomor `-1`, `-2` bila kelompok itu lebih dari satu halaman.

### Urutan URL dan pergeseran halaman

Di dalam tiap kelompok, URL diurutkan menaik berdasarkan path (tanpa prefix bahasa), sehingga hasil stabil antar-run dan commit hanya terjadi bila isi benar-benar berubah. Konsekuensinya, URL baru yang disisipkan di tengah urutan menggeser URL sesudahnya ke halaman berikutnya (misalnya URL ke-100 pindah dari `-1` ke `-2`). Ini wajar; isi file yang terdampak berubah, tetapi tidak ada URL yang hilang atau ganda.

## Menjalankan di komputer sendiri

Butuh Node.js 20 atau lebih baru. Tanpa `npm install`.

```bash
npm test                                   # jalankan test
node src/build-sitemap.mjs --allow-placeholder --out out
# atau dari file lokal:
node src/build-sitemap.mjs --input sitemap.xml --out out --allow-placeholder
```

Hasil ada di folder `out/`. Perilaku pengaman jumlah URL bisa dilewati dengan `FORCE=1` (hanya jika penurunan memang disengaja).

## Pemecahan masalah

- **Workflow gagal "turun dari X ke Y"**: pengaman bekerja. Cek apakah sitemap Webflow memang berubah drastis. Bila disengaja, jalankan ulang dengan `FORCE=1`.
- **"Sumber berupa sitemap index"**: Webflow mengubah format sitemap. Sesuaikan `sourceUrl` atau script.
- **Perlu kembali ke sitemap Webflow**: di robots.txt Webflow, matikan *Remove sitemap.xml from robots.txt* dan hapus baris `Sitemap:` eksternal, lalu publish.
- **Workflow berhenti sendiri**: GitHub dapat menonaktifkan workflow terjadwal pada repositori yang lama tanpa aktivitas. Cek tab Actions secara berkala dan aktifkan kembali bila perlu.

## Catatan

- Halaman thank-you dan `dev/` sebaiknya juga `noindex` di level halaman. Sitemap hanya menentukan apa yang diajukan ke Google.
- Batas keras 45.000 URL per file tetap berlaku sebagai pengaman (limit protokol 50.000 URL / 50 MB), apa pun nilai `pageSize`.
- `docs/stats.json` berisi jumlah URL per file (`files`) dan per kelompok (`groups`, misalnya `"de/knowledge": { "urls": 198, "files": 2 }`), tanpa timestamp, agar commit hanya terjadi saat hasil berubah.
