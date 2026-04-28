/**
 * Standalone: for each mapping row, if B/D/E has text, that string must match the vendor CSV;
 * if a vendor cell is empty, column A (reference) is fuzzy-matched in that vendor’s CSV.
 *
 * Required in project root `.env` (paths can be relative to repo root):
 *   BIWEEKLY_MAPPING_SHEET_URL  (xlsx export URL) — or MAPPING_XLSX_PATH to a local .xlsx
 *   PFG_CSV, SYSCO_CSV, GFS_CSV  — paths to the three order-guide exports
 * Optional: MAPPING_VERIFY_MAX_ROWS (default 500)
 */
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { assertMappingTermsInDownloadedCsvs } = require('./lib/mapping-csv-term-verify');

const repoRoot = path.join(__dirname, '..');
const dotenvPath = path.join(repoRoot, '.env');
require('dotenv').config({ path: dotenvPath });

/** Resolve CSV/mapping paths; relative paths are from repo root */
function resolveEnvPath(p) {
  const t = (p || '').trim();
  if (!t) return '';
  return path.isAbsolute(t) ? t : path.join(repoRoot, t);
}

test('Mapping rows: explicit B/D/E in CSV, or fuzzy reference (col A) per vendor', async () => {
  const pfg = resolveEnvPath(process.env.PFG_CSV);
  const sysco = resolveEnvPath(process.env.SYSCO_CSV);
  const gfs = resolveEnvPath(process.env.GFS_CSV);
  const mapPath = resolveEnvPath(process.env.MAPPING_XLSX_PATH);
  const mapUrl = (process.env.BIWEEKLY_MAPPING_SHEET_URL || '').trim();

  const missingEnv = [];
  if (!pfg) missingEnv.push('PFG_CSV');
  if (!sysco) missingEnv.push('SYSCO_CSV');
  if (!gfs) missingEnv.push('GFS_CSV');
  if (!mapUrl && !mapPath) missingEnv.push('BIWEEKLY_MAPPING_SHEET_URL or MAPPING_XLSX_PATH');

  if (missingEnv.length > 0) {
    test.skip(
      true,
      [
        `Missing: ${missingEnv.join(', ')}.`,
        `Add them to ${dotenvPath} (loaded ${fs.existsSync(dotenvPath) ? 'OK' : 'NOT FOUND'}).`,
        'Example relative to repo: PFG_CSV=tmp-biweekly-test/pfg.csv',
        'Example mapping: BIWEEKLY_MAPPING_SHEET_URL=https://docs.google.com/spreadsheets/d/.../export?format=xlsx&gid=...'
      ].join(' ')
    );
  }

  if (!fs.existsSync(pfg)) throw new Error(`PFG_CSV file not found: ${pfg}`);
  if (!fs.existsSync(sysco)) throw new Error(`SYSCO_CSV file not found: ${sysco}`);
  if (!fs.existsSync(gfs)) throw new Error(`GFS_CSV file not found: ${gfs}`);
  if (mapPath && !fs.existsSync(mapPath)) throw new Error(`MAPPING_XLSX_PATH file not found: ${mapPath}`);

  const v = await assertMappingTermsInDownloadedCsvs({
    mappingUrl: mapPath || mapUrl, // URL string for fetch, or absolute local .xlsx path
    pfgPath: pfg,
    syscoPath: sysco,
    gfsPath: gfs
  });
  if (!v.ok) {
    // eslint-disable-next-line no-console
    console.log('[mapping check stats]', v.stats, v.missing);
  }
  expect(v.ok, v.message).toBe(true);
});
