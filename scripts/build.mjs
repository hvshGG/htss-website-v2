import { cp, mkdir, readFile, writeFile, access, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const files = ['index.html', 'privacy.html', 'favicon.svg', 'social-preview.svg', 'robots.txt', 'site-config.js'];
const html = await readFile(path.join(root, 'index.html'), 'utf8');
if (/<script\b[^>]*src=["']https?:/i.test(html) || /\bon(?:click|submit|load)\s*=/i.test(html)) {
  throw new Error('HTML must use local scripts and external event handlers.');
}
for (const match of html.matchAll(/(?:src|href)="((?:assets\/|site-config\.js|favicon\.svg)[^"?#]*)/g)) {
  await access(path.join(root, match[1]));
}
// Clean only this checkout's generated directory; never follow an output symlink.
if (path.dirname(path.resolve(dist)) !== path.resolve(root) || path.basename(dist) !== 'dist') {
  throw new Error('Build output must stay in this project/dist.');
}
const oldOutput = await lstat(dist).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (oldOutput?.isSymbolicLink()) throw new Error('Build output must not be a symbolic link.');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(path.join(root, file), path.join(dist, file));
await cp(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

// Set SITE_URL at build time to add domain-specific SEO without a placeholder domain.
const siteUrl = process.env.SITE_URL;
let robots = 'User-agent: *\nAllow: /\n';
if (siteUrl) {
  const url = new URL(siteUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SITE_URL must be an HTTPS site URL without credentials, query or fragment.');
  }
  const base = new URL('./', url.href.endsWith('/') ? url.href : `${url.href}/`).href;
  const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  for (const [file, canonical] of [['index.html', base], ['privacy.html', new URL('privacy.html', base).href]]) {
    const source = await readFile(path.join(dist, file), 'utf8');
    const tags = `<link rel="canonical" href="${escape(canonical)}">\n<meta property="og:url" content="${escape(canonical)}">\n<meta property="og:image" content="${escape(new URL('assets/media/hero-poster-1280.webp', base).href)}">`;
    await writeFile(path.join(dist, file), source.replace('<!-- deployment-meta -->', tags));
  }
}
await writeFile(path.join(dist, 'robots.txt'), robots);
console.log('Built dist/: HTML, styles, scripts and local media.');
