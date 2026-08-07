#!/usr/bin/env node
/**
 * Build size report with optional budgets.
 *
 * Usage:
 *   node scripts/size-budget.mjs                # report; enforce size-budgets.json if present
 *   node scripts/size-budget.mjs --no-check     # report only, never fail
 *   node scripts/size-budget.mjs --dist=out     # analyze a different output directory
 *   node scripts/size-budget.mjs --budgets=path # use a different budget file
 *
 * Vendored rather than imported so a fork builds from nothing but this repo:
 * someone auditing a privacy tool should not have to trust a separate package
 * to reproduce the build.
 *
 * The js budget is the one that bites here. pdf.js is most of what ships and it
 * grows with every dependency bump, so the ceiling is what turns that from an
 * unnoticed drift into a failed build.
 *
 * Budget file (size-budgets.json in the repo root, all values in KB):
 *   {
 *     "gzipKB": { "html": 70, "css": 25, "js": 10 },
 *     "rawKB": { "images": 800, "videos": 30000 }
 *   }
 * Compressible categories (html, css, js) are budgeted on gzip size; media
 * categories (fonts, images, videos) on raw size. "total" is allowed in
 * either table. Raise a budget deliberately; never to silence a failure.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { gzipSync } from 'zlib';

const CATEGORIES = {
  html: ['.html'],
  css: ['.css'],
  js: ['.js', '.mjs'],
  fonts: ['.woff2', '.woff', '.ttf', '.otf'],
  images: ['.avif', '.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'],
  videos: ['.mp4', '.webm'],
};

// Only gzip what actually ships compressed; media is already-compressed bytes.
const GZIPPED = new Set(['html', 'css', 'js', 'other']);

function parseArgs(argv) {
  const args = { dist: 'dist', budgets: 'size-budgets.json', check: true };
  for (const arg of argv) {
    if (arg === '--no-check') args.check = false;
    else if (arg.startsWith('--dist=')) args.dist = arg.slice('--dist='.length);
    else if (arg.startsWith('--budgets=')) args.budgets = arg.slice('--budgets='.length);
  }
  return args;
}

function categoryFor(file) {
  const ext = extname(file).toLowerCase();
  for (const [category, exts] of Object.entries(CATEGORIES)) {
    if (exts.includes(ext)) return category;
  }
  return 'other';
}

function collectFiles(dir, distRoot, files = []) {
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    // lstat: a symlink pointing at an ancestor directory would recurse forever
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      collectFiles(filePath, distRoot, files);
    } else {
      const category = categoryFor(entry);
      files.push({
        name: filePath.slice(distRoot.length + 1),
        category,
        size: stat.size,
        gzipSize: GZIPPED.has(category) ? gzipSync(readFileSync(filePath)).length : null,
      });
    }
  }
  return files;
}

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(2).padStart(9)} KB`;
}

function printCategory(category, files) {
  const inCategory = files.filter((f) => f.category === category);
  if (inCategory.length === 0) return;

  const gzipped = GZIPPED.has(category);
  const sortKey = gzipped ? 'gzipSize' : 'size';
  console.log(
    `\n${category} (${inCategory.length} files, top 10 by ${gzipped ? 'gzip' : 'raw'} size):`
  );

  for (const file of [...inCategory].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 10)) {
    const sizes = gzipped
      ? `${formatKB(file.size)} -> ${formatKB(file.gzipSize)}`
      : formatKB(file.size);
    console.log(`  ${file.name.padEnd(48)} ${sizes}`);
  }

  const totalRaw = inCategory.reduce((sum, f) => sum + f.size, 0);
  const totalGzip = gzipped ? inCategory.reduce((sum, f) => sum + f.gzipSize, 0) : null;
  const totals = gzipped ? `${formatKB(totalRaw)} -> ${formatKB(totalGzip)}` : formatKB(totalRaw);
  console.log(`  ${'total'.padEnd(48)} ${totals}`);
}

function categoryTotals(files) {
  const totals = {};
  for (const file of files) {
    const t = (totals[file.category] ??= { raw: 0, gzip: 0 });
    t.raw += file.size;
    t.gzip += file.gzipSize ?? 0;
  }
  totals.total = {
    raw: files.reduce((sum, f) => sum + f.size, 0),
    gzip: files.reduce((sum, f) => sum + (f.gzipSize ?? f.size), 0),
  };
  return totals;
}

function checkBudgets(budgets, totals) {
  const violations = [];
  const tables = [
    { key: 'gzipKB', measure: 'gzip', label: 'gzip' },
    { key: 'rawKB', measure: 'raw', label: 'raw' },
  ];

  // A typo'd category would resolve to 0 bytes and pass forever, so fail loudly instead
  const knownCategories = new Set([...Object.keys(CATEGORIES), 'other', 'total']);
  for (const { key } of tables) {
    for (const category of Object.keys(budgets[key] ?? {})) {
      if (!knownCategories.has(category)) {
        console.error(
          `size-budget: unknown budget category "${category}" in ${key}. Valid: ${[...knownCategories].join(', ')}`
        );
        process.exit(1);
      }
    }
  }

  for (const { key, measure, label } of tables) {
    for (const [category, limitKB] of Object.entries(budgets[key] ?? {})) {
      const actual = totals[category]?.[measure] ?? 0;
      const actualKB = actual / 1024;
      const line = `${category} (${label}): ${actualKB.toFixed(1)} KB of ${limitKB} KB budget`;
      if (actualKB > limitKB) violations.push(line);
      else console.log(`  ok  ${line}`);
    }
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.dist)) {
    console.error(`size-budget: output directory "${args.dist}" not found. Run the build first`);
    process.exit(1);
  }

  const files = collectFiles(args.dist, args.dist);
  if (files.length === 0) {
    console.error(
      `size-budget: "${args.dist}" contains no files. A broken or misdirected build must not pass budgets`
    );
    process.exit(1);
  }
  const totals = categoryTotals(files);

  console.log(`\nBuild size report (${args.dist}, ${files.length} files)`);
  console.log('='.repeat(76));
  for (const category of [...Object.keys(CATEGORIES), 'other']) {
    printCategory(category, files);
  }
  console.log('\n' + '='.repeat(76));
  console.log(
    `total: ${formatKB(totals.total.raw)} raw, ${formatKB(totals.total.gzip)} transfer-ish (gzip for text, raw for media)\n`
  );

  if (!args.check) return;
  if (!existsSync(args.budgets)) {
    console.log(`no ${args.budgets} found, report only, nothing enforced\n`);
    return;
  }

  console.log(`budgets (${args.budgets}):`);
  const budgets = JSON.parse(readFileSync(args.budgets, 'utf8'));
  const violations = checkBudgets(budgets, totals);
  console.log('');

  if (violations.length > 0) {
    console.error('size-budget: size budget exceeded:');
    for (const violation of violations) console.error(`  FAIL ${violation}`);
    console.error('Raise the budget in size-budgets.json only if the growth is deliberate.\n');
    process.exit(1);
  }
}

main();
