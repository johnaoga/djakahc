#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toSlug(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseField(markdown, heading) {
  const h = escapeRegex(heading);
  // Allow CRLF/LF, tolerate trailing spaces, and stop at next heading or end
  const re = new RegExp(`^###\\s+${h}\\s*\r?\n([\\s\\S]*?)(?=\r?\n###\\s|\r?\n?$|$)`, 'mi');
  const m = markdown.match(re);
  if (!m) return '';
  return m[1].trim();
}

function parseCommaList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function buildFrontMatter(section, data) {
  const lines = ['---'];
  lines.push(`title: "${data.title.replace(/\\"/g, '\\\\"')}"`);
  lines.push(`date: ${data.date || new Date().toISOString()}`);
  lines.push(`draft: false`);

  if (section === 'news') {
    lines.push(`highlight: ${data.highlight ? 'true' : 'false'}`);
    if (data.summary) lines.push(`summary: "${data.summary.replace(/\\"/g, '\\\\"')}"`);
    if (data.cover) lines.push(`cover: "${data.cover}"`);
    if (data.tags && data.tags.length) lines.push(`tags: [${data.tags.map(t => `\"${t}\"`).join(', ')}]`);
    if (data.categories && data.categories.length) lines.push(`categories: [${data.categories.map(t => `\"${t}\"`).join(', ')}]`);
    if (data.gallery && data.gallery.length) lines.push(`gallery: [${data.gallery.map(g => `\"${g}\"`).join(', ')}]`);
  }

  // Editorial theme posts
  if (section === 'posts') {
    if (data.summary) lines.push(`summary: "${data.summary.replace(/\\"/g, '\\\\"')}"`);
    if (data.featuredImage) lines.push(`featuredImage: "${data.featuredImage}"`);
    if (data.tags && data.tags.length) lines.push(`tags: [${data.tags.map(t => `\"${t}\"`).join(', ')}]`);
    if (data.categories && data.categories.length) lines.push(`categories: [${data.categories.map(t => `\"${t}\"`).join(', ')}]`);
  }

  if (section === 'competitions') {
    if (data.startDate) lines.push(`startDate: ${data.startDate}`);
    if (data.endDate) lines.push(`endDate: ${data.endDate}`);
    if (data.location) lines.push(`location: \"${data.location.replace(/\\"/g, '\\\\"')}\"`);
    if (data.summary) lines.push(`summary: \"${data.summary.replace(/\\"/g, '\\\\"')}\"`);
    if (data.cover) lines.push(`cover: \"${data.cover}\"`);
    if (data.gallery && data.gallery.length) lines.push(`gallery: [${data.gallery.map(g => `\"${g}\"`).join(', ')}]`);
  }

  if (section === 'players') {
    if (data.name) lines.push(`name: "${data.name.replace(/"/g, '\\"')}"`);
    if (data.gender) lines.push(`gender: "${data.gender}"`);
    if (data.category) lines.push(`category: "${data.category.replace(/"/g, '\\"')}"`);
    if (data.photo) lines.push(`photo: "${data.photo}"`);
  }

  lines.push('---');
  return lines.join('\n');
}

function stripCodeFences(md) {
  if (!md) return '';
  const trimmed = md.trim();
  // Remove surrounding triple backtick fences if present
  const fenceRe = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/m;
  const m = trimmed.match(fenceRe);
  if (m) return m[1].trim() + '\n';
  return md;
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(s || '');
}

function urlToFileParts(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname);
    const name = base ? base.split('?')[0] : '';
    const ext = path.extname(name) || '.jpg';
    return { name: name || `image${ext}`, ext };
  } catch {
    return { name: 'image.jpg', ext: '.jpg' };
  }
}

function downloadImage(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(urlStr, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirects
        res.destroy();
        return resolve(downloadImage(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        file.close(() => {
          fs.unlink(destPath, () => resolve(null));
        });
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', err => {
      file.close(() => {
        fs.unlink(destPath, () => resolve(null));
      });
    });
  });
}

async function rewriteAndDownloadImages(markdown, itemDir) {
  if (!markdown) return markdown;
  let idx = 1;
  const used = new Set();
  const replaced = await markdown.replace(/!\[[^\]]*\]\((https?:[^)\s]+)[^)]*\)/gi, (match, urlStr) => {
    const { ext } = urlToFileParts(urlStr);
    let filename;
    do {
      filename = `image-${idx}${ext}`;
      idx++;
    } while (used.has(filename));
    used.add(filename);
    const dest = path.join(itemDir, filename);
    // Fire and forget; we'll await all by collecting promises below
    pendingDownloads.push(downloadImage(urlStr, dest));
    return match.replace(urlStr, filename);
  });
  // Wait for all downloads started above
  await Promise.allSettled(pendingDownloads);
  return replaced;
}

let pendingDownloads = [];

async function main() {
  const payloadPath = process.env.GITHUB_EVENT_PATH;
  if (!payloadPath) {
    console.error('GITHUB_EVENT_PATH not set');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const issue = payload.issue;
  if (!issue) {
    console.error('No issue in event payload');
    process.exit(0);
  }

  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  const section = labels.find(l => l.startsWith('type:'))?.split(':')[1];
  if (!section) {
    console.error('No type: label found');
    process.exit(0);
  }

  // Map to content subfolder names
  const sectionMap = {
    news: 'news',
    competition: 'competitions',
    player: 'players',
    post: 'posts',
  };
  const contentSection = sectionMap[section];
  if (!contentSection) {
    console.error('Unknown section for type label:', section);
    process.exit(0);
  }

  const body = issue.body || '';

  // Parse common fields rendered by GitHub issue forms
  const lang = parseField(body, 'Language') || 'fr';

  let data = {};
  if (section === 'news') {
    data.title = parseField(body, 'Title') || issue.title || 'Untitled';
    data.summary = parseField(body, 'Summary (short)');
    data.cover = parseField(body, 'Cover image relative path (optional)');
    data.tags = parseCommaList(parseField(body, 'Tags (comma separated)'));
    data.categories = parseCommaList(parseField(body, 'Categories (comma separated)'));
    // gallery field label from issue template
    data.gallery = parseCommaList(parseField(body, 'Gallery images (comma separated, optional)'));
    // cover field label may be updated; also try alternate label
    if (!data.cover) data.cover = parseField(body, 'Cover image filename or static path (optional)');
    data.content = stripCodeFences(parseField(body, 'Content (Markdown)'));
  } else if (section === 'competition') {
    data.title = parseField(body, 'Title') || issue.title || 'Untitled';
    data.startDate = parseField(body, 'Start date (YYYY-MM-DD)');
    data.endDate = parseField(body, 'End date (YYYY-MM-DD)');
    data.location = parseField(body, 'Location');
    data.cover = parseField(body, 'Cover image relative path (optional)') || parseField(body, 'Cover image filename or static path (optional)');
    data.summary = parseField(body, 'Summary (short)');
    data.gallery = parseCommaList(parseField(body, 'Gallery images (comma separated, optional)'));
    data.content = stripCodeFences(parseField(body, 'Description (Markdown)'));
  } else if (section === 'player') {
    data.title = parseField(body, 'Player full name') || issue.title || 'Player';
    data.name = parseField(body, 'Player full name');
    data.gender = parseField(body, 'Gender');
    data.category = parseField(body, 'Category');
    data.photo = parseField(body, 'Photo relative path (optional)');
    data.content = stripCodeFences(parseField(body, 'Bio / Notes (Markdown)'));
  } else if (section === 'post') {
    data.title = parseField(body, 'Title') || issue.title || 'Untitled';
    data.summary = parseField(body, 'Summary (short)');
    data.featuredImage = parseField(body, 'Featured image relative path (optional)');
    if (!data.featuredImage) data.featuredImage = parseField(body, 'Cover image relative path (optional)') || parseField(body, 'Cover image filename or static path (optional)');
    data.tags = parseCommaList(parseField(body, 'Tags (comma separated)'));
    data.categories = parseCommaList(parseField(body, 'Categories (comma separated)'));
    data.content = stripCodeFences(parseField(body, 'Content (Markdown)'));
  }

  const datePrefix = todayISO();
  const slugSource = data.title || data.name || issue.title || 'item';
  const slug = `${datePrefix}-${toSlug(slugSource)}`;

  const baseDir = path.join(process.cwd(), 'content', lang, contentSection);
  ensureDir(baseDir);
  // Create a Hugo leaf bundle: one folder per item with an index.md
  const itemDir = path.join(baseDir, slug);
  ensureDir(itemDir);
  const filePath = path.join(itemDir, 'index.md');

  // Download featured image if it's an external URL and rewrite to local filename
  if (data.featuredImage && isHttpUrl(data.featuredImage)) {
    const { ext } = urlToFileParts(data.featuredImage);
    const localFeatured = `featured${ext}`;
    const dest = path.join(itemDir, localFeatured);
    await downloadImage(data.featuredImage, dest);
    data.featuredImage = localFeatured;
  }

  // Rewrite and download external images in content
  let bodyContent = data.content || '';
  pendingDownloads = [];
  bodyContent = await rewriteAndDownloadImages(bodyContent, itemDir);

  const fm = buildFrontMatter(contentSection, data);
  const lead = contentSection === 'news' ? `\n\n{{< lead >}}${data.title}{{< /lead >}}\n\n` : '\n\n';
  const content = `${fm}${lead}${bodyContent}\n`;

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Generated:', filePath);
}

// Run
main().catch(err => {
  console.error('Generator failed:', err);
  process.exit(1);
});
