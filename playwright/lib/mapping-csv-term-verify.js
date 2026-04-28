/**
 * Verify mapping sheet rows against downloaded vendor CSVs:
 * - When PFG/Sysco/GFS columns (B/D/E) have text → match that term in the corresponding CSV
 *   (normalized contains, chunk, or token overlap — same fuzzy idea as the app).
 * - When a vendor column is empty but column A (reference) is set → fuzzy-match the reference
 *   name in that vendor’s CSV instead.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

function mappingCellToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text != null && String(v.text).trim() !== '') return String(v.text);
    if (v.result !== undefined && v.result !== null) return mappingCellToString(v.result);
    if (v.hyperlink !== undefined) return String(v.text || '').trim() || String(v.hyperlink || '');
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text || '').join('');
    return '';
  }
  return String(v);
}

function normalizeForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileDoesNotLookLikeCsv(raw) {
  const head = raw.slice(0, 600);
  if (/^\s*<\?xml/i.test(head) && /<svg/i.test(head)) return true;
  if (/^\s*<!doctype html/i.test(head) || (/<\s*html/i.test(head) && !/,/.test(raw.slice(0, 5000)))) return true;
  const t = raw.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (t.startsWith('(function') || t.includes('GooglebQhCsO')) return true;
  return false;
}

function cellTextPreferDisplay(cell) {
  if (!cell) return '';
  try {
    const raw = cell.text;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (raw && typeof raw === 'object' && Array.isArray(raw.richText)) {
      const joined = raw.richText.map((p) => p.text || '').join('');
      if (joined.trim()) return joined.trim();
    }
  } catch (_) {
    /* fall through */
  }
  const fromValue = mappingCellToString(cell.value).trim();
  if (fromValue && fromValue !== '[object Object]') return fromValue;
  try {
    const m = cell.model;
    if (m && m.value !== undefined && m.value !== null) {
      const alt = mappingCellToString(m.value).trim();
      if (alt && alt !== '[object Object]') return alt;
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

function isUsefulTerm(t) {
  const s = String(t || '').trim();
  if (s.length < 3) return false;
  if (s === '[object Object]' || /^\[object\s+object\]$/i.test(s)) return false;
  return true;
}

/**
 * Fuzzy match one term against normalized full-file haystack (same strategies as server-side normalization).
 */
function termMatchesInHaystack(hay, term, { minTermLen = 4, subChunkMin = 12 } = {}) {
  const n = normalizeForSearch(term);
  if (n.length < minTermLen) return true;
  if (hay.includes(n)) return true;
  const chunk = n.slice(0, Math.min(48, n.length));
  if (chunk.length >= subChunkMin && hay.includes(chunk)) return true;
  const words = n.split(' ').filter((w) => w.length > 2);
  if (words.length >= 3) {
    const ok = words.filter((w) => hay.includes(w)).length / words.length >= 0.65;
    if (ok) return true;
  }
  if (words.length === 2) {
    if (words.every((w) => hay.includes(w))) return true;
  }
  return false;
}

/** Mirrors `server.js` — fuzzy match provider text → reference name (same threshold). */
function normalizeProductName(name) {
  if (!name) return '';
  let normalized = String(name).toLowerCase().trim();
  normalized = normalized
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+(the|a|an)$/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized;
}

function wordsSimilar(word1, word2) {
  if (word1 === word2) return true;
  const singular1 = word1.replace(/s$/, '');
  const singular2 = word2.replace(/s$/, '');
  if (singular1 === word2 || word1 === singular2 || singular1 === singular2) return true;
  const variations = {
    wing: ['wings'],
    pretzel: ['pretzels'],
    bite: ['bites'],
    tender: ['tenders'],
    chicken: ['chickens'],
    beef: ['beefs'],
    pork: ['porks']
  };
  for (const [key, values] of Object.entries(variations)) {
    if ((word1 === key && values.includes(word2)) || (word2 === key && values.includes(word1))) {
      return true;
    }
  }
  if (word1.length > 3 && word2.length > 3) {
    if (word1.includes(word2) || word2.includes(word1)) return true;
  }
  return false;
}

function calculateSimilarity(productName, referenceName) {
  const productWords = normalizeProductName(productName)
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const refWords = normalizeProductName(referenceName)
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (productWords.length === 0 || refWords.length === 0) return 0;
  if (normalizeProductName(productName) === normalizeProductName(referenceName)) return 100;
  let matches = 0;
  const totalWords = Math.max(productWords.length, refWords.length);
  productWords.forEach((pWord) => {
    refWords.forEach((rWord) => {
      if (wordsSimilar(pWord, rWord)) matches++;
    });
  });
  const wordScore = (matches / totalWords) * 80;
  const normalizedProduct = normalizeProductName(productName);
  const normalizedRef = normalizeProductName(referenceName);
  let substringScore = 0;
  if (normalizedProduct.includes(normalizedRef) || normalizedRef.includes(normalizedProduct)) {
    substringScore = 15;
  }
  return Math.min(100, wordScore + substringScore);
}

function matchProductName(productName, referenceProducts) {
  if (!productName || !referenceProducts || referenceProducts.length === 0) return null;
  const normalized = normalizeProductName(productName);
  if (!normalized) return null;
  const exactMatch = referenceProducts.find((ref) => normalizeProductName(ref) === normalized);
  if (exactMatch) return exactMatch;
  const scores = referenceProducts.map((ref) => ({
    product: ref,
    score: calculateSimilarity(productName, ref)
  }));
  scores.sort((a, b) => b.score - a.score);
  if (scores.length > 0 && scores[0].score >= 30) return scores[0].product;
  return null;
}

// --- CSV layout aligned with `server.js` `build*ProviderExtractOptions` + `parseCsvRows` ---

function stripBom(text) {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  else if (t.startsWith('\uFEFF')) t = t.slice(1);
  return t;
}

function detectCsvDelimiter(csvText) {
  const firstLine = csvText.split(/\r?\n/).find((l) => l && l.trim().length > 0) || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  return semiCount > commaCount ? ';' : ',';
}

function parseCsvRows(csvText, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && csvText[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      const isRowEmpty = row.every((c) => c === null || c === undefined || c.toString().trim() === '');
      if (!isRowEmpty) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  const isRowEmpty = row.every((c) => c === null || c === undefined || c.toString().trim() === '');
  if (!isRowEmpty) rows.push(row);
  return rows;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const str = value.toString().trim();
  if (!str) return null;
  const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
  return Number.isNaN(num) ? null : num;
}

function parseBiweeklyIntEnv(name, def) {
  const v = (process.env[name] || '').trim();
  if (v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseBiweeklyStartRow1Env(name) {
  const v = (process.env[name] || '').trim();
  if (v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function inferGfsOrderGuideLayout(csvRows) {
  const n = Math.min(csvRows.length, 200);
  const colVotes = new Map();
  const priceCol = 4;
  for (let r = 0; r < n; r++) {
    const row = csvRows[r] || [];
    const price = parseNumber(row[priceCol]);
    if (price === null || price <= 0) continue;
    let bestC = 0;
    let bestLen = 0;
    for (let c = 0; c < Math.min(row.length, 16); c++) {
      if (c === priceCol) continue;
      const t = (row[c] || '').toString().trim();
      if (t.length < 4) continue;
      if (/^[$]?\s*[\d,]+\.?\d*\s*$/i.test(t)) continue;
      if (t.length > bestLen) {
        bestLen = t.length;
        bestC = c;
      }
    }
    if (bestLen >= 4) colVotes.set(bestC, (colVotes.get(bestC) || 0) + 1);
  }
  let productCol = 1;
  if (colVotes.size > 0) {
    const sorted = [...colVotes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    productCol = sorted[0][0];
  }
  let startIndex0 = 1;
  for (let r = 0; r < n; r++) {
    const row = csvRows[r] || [];
    const pr = (row[productCol] || '').toString().trim();
    const price = parseNumber(row[priceCol]);
    if (pr.length >= 4 && price !== null && price > 0) {
      startIndex0 = r;
      break;
    }
  }
  return { productCol, priceCol, startIndex0 };
}

function inferProviderDataStartIndex(csvRows, productCol, priceCol, defaultStartIndex0) {
  for (let r = 0; r < Math.min(50, csvRows.length); r++) {
    const row = csvRows[r] || [];
    const pr = (row[productCol] || '').toString().trim();
    const price = parseNumber(row[priceCol]);
    if (pr.length >= 3 && price !== null && price > 0) return r;
  }
  return defaultStartIndex0;
}

function buildPfgExtract(csvRows) {
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_PFG_PRODUCT_COL', 0);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_PFG_PRICE_COL', 7);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_PFG_START_ROW');
  const minDataRow0 = 8;
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : Math.max(minDataRow0, inferProviderDataStartIndex(csvRows, productCol, priceCol, minDataRow0));
  return { vendorName: 'PFG', productCol, priceCol, startRow: startIndex0 + 1 };
}

function buildSyscoExtract(csvRows) {
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_SYSCO_PRODUCT_COL', 12);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_SYSCO_PRICE_COL', 14);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_SYSCO_START_ROW');
  const minDataRow0 = 2;
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : Math.max(minDataRow0, inferProviderDataStartIndex(csvRows, productCol, priceCol, minDataRow0));
  return { vendorName: 'Sysco', productCol, priceCol, startRow: startIndex0 + 1 };
}

function buildGfsExtract(csvRows) {
  const inf = inferGfsOrderGuideLayout(csvRows);
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_GFS_PRODUCT_COL', inf.productCol);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_GFS_PRICE_COL', inf.priceCol);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_GFS_START_ROW');
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : inferProviderDataStartIndex(csvRows, productCol, priceCol, inf.startIndex0);
  return { vendorName: 'GFS', productCol, priceCol, startRow: startIndex0 + 1 };
}

function parseCsvTextToRows(rawCsv) {
  const text = stripBom(rawCsv);
  const delim = detectCsvDelimiter(text);
  return parseCsvRows(text, delim);
}

/**
 * True if `term` is matched the same way the server would treat a mapping alias / reference against
 * **product-description cells** (not random header/footer lines): haystack scan first, then each
 * vendor product column from the parsed data start row (PFG/Sysco/GFS layout mirrors server.js).
 */
function vendorCsvMappingTermMatches(rawCsv, vendorKey, term) {
  if (!isUsefulTerm(term)) return true;
  const hay = normalizeForSearch(rawCsv);
  if (termMatchesInHaystack(hay, term)) return true;

  const rows = parseCsvTextToRows(rawCsv);
  const opts =
    vendorKey === 'PFG'
      ? buildPfgExtract(rows)
      : vendorKey === 'Sysco'
        ? buildSyscoExtract(rows)
        : buildGfsExtract(rows);

  const startIndex0 = Math.max(0, opts.startRow - 1);
  const candidates = [term];
  for (let r = startIndex0; r < rows.length; r++) {
    const cell = (rows[r][opts.productCol] || '').toString().trim();
    if (cell.length < 3) continue;
    if (matchProductName(cell, candidates) === term) return true;
    if (calculateSimilarity(cell, term) >= 30) return true;
  }
  return false;
}

function loadNormalizedHay(csvFilePath) {
  const raw = fs.readFileSync(csvFilePath, 'utf8');
  if (fileDoesNotLookLikeCsv(raw)) {
    throw new Error(
      `File does not look like CSV (HTML/SVG/XML?). First bytes: ${raw.slice(0, 100).replace(/\n/g, ' ')}`
    );
  }
  return normalizeForSearch(raw);
}

function loadRawAndHayForVerify(csvFilePath) {
  const raw = fs.readFileSync(csvFilePath, 'utf8');
  if (fileDoesNotLookLikeCsv(raw)) {
    throw new Error(
      `File does not look like CSV (HTML/SVG/XML?). First bytes: ${raw.slice(0, 100).replace(/\n/g, ' ')}`
    );
  }
  return { raw, hay: normalizeForSearch(raw) };
}

async function loadWorkbookFromMappingUrlOrPath(mappingUrl) {
  const url = (mappingUrl || '').trim();
  if (!url) {
    throw new Error('Missing mapping source (BIWEEKLY_MAPPING_SHEET_URL or path)');
  }
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Mapping fetch failed: ${res.status} ${res.statusText} ${url.slice(0, 120)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
  }
  const p = path.resolve(url);
  if (!fs.existsSync(p)) {
    throw new Error(`Mapping file not found: ${p}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  return wb;
}

/**
 * Fixed layout: A=reference, B=PFG, C=US (ignored), D=Sysco, E=GFS — flat lists (legacy helpers).
 */
function extractProviderTermsFromWorksheet(worksheet) {
  const pfg = [];
  const sysco = [];
  const gfs = [];
  for (let r = 2; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const p = cellTextPreferDisplay(row.getCell(2));
    const s = cellTextPreferDisplay(row.getCell(4));
    const g = cellTextPreferDisplay(row.getCell(5));
    if (p) pfg.push(p);
    if (s) sysco.push(s);
    if (g) gfs.push(g);
  }
  return { pfg, sysco, gfs };
}

/** @deprecated use row-wise assertMappingTermsInDownloadedCsvs */
function findMissingTermsInCsvFile(csvFilePath, terms, opts = {}) {
  const hay = loadNormalizedHay(csvFilePath);
  const missing = [];
  for (const t of terms) {
    if (!isUsefulTerm(t)) continue;
    if (!termMatchesInHaystack(hay, t, opts)) missing.push(t);
  }
  return missing;
}

/**
 * Per mapping row: explicit vendor text when present; otherwise fuzzy-match reference (col A) in that vendor CSV.
 */
async function assertMappingTermsInDownloadedCsvs(options) {
  const {
    mappingUrl = process.env.BIWEEKLY_MAPPING_SHEET_URL,
    pfgPath,
    syscoPath,
    gfsPath,
    maxRows = parseInt(process.env.MAPPING_VERIFY_MAX_ROWS || '500', 10) || 500
  } = options;

  const wb = await loadWorkbookFromMappingUrlOrPath(mappingUrl);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Mapping workbook has no sheets');

  const { raw: rawPfg } = loadRawAndHayForVerify(pfgPath);
  const { raw: rawSysco } = loadRawAndHayForVerify(syscoPath);
  const { raw: rawGfs } = loadRawAndHayForVerify(gfsPath);

  /** Reference-only rows (empty B/D/E): optional — live exports often omit discontinued items. */
  const verifyEmptyPrimary =
    String(process.env.PW_MAPPING_VERIFY_EMPTY_PRIMARY || '').trim() === '1';

  const missing = { pfg: [], sysco: [], gfs: [] };
  const stats = {
    rowsScanned: 0,
    pfgExplicit: 0,
    pfgFuzzyRef: 0,
    syscoExplicit: 0,
    syscoFuzzyRef: 0,
    gfsExplicit: 0,
    gfsFuzzyRef: 0
  };

  const lastRow = Math.min(ws.rowCount, maxRows + 1);
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const ref = cellTextPreferDisplay(row.getCell(1));
    const pfg = cellTextPreferDisplay(row.getCell(2));
    const sysco = cellTextPreferDisplay(row.getCell(4));
    const gfs = cellTextPreferDisplay(row.getCell(5));

    if (!ref && !pfg && !sysco && !gfs) continue;
    stats.rowsScanned++;

    if (isUsefulTerm(pfg)) {
      stats.pfgExplicit++;
      if (!vendorCsvMappingTermMatches(rawPfg, 'PFG', pfg)) missing.pfg.push(`row ${r} PFG text: ${pfg}`);
    } else if (isUsefulTerm(ref)) {
      stats.pfgFuzzyRef++;
      if (verifyEmptyPrimary && !vendorCsvMappingTermMatches(rawPfg, 'PFG', ref)) {
        missing.pfg.push(`row ${r} PFG (no alias — fuzzy ref): ${ref}`);
      }
    }

    if (isUsefulTerm(sysco)) {
      stats.syscoExplicit++;
      if (!vendorCsvMappingTermMatches(rawSysco, 'Sysco', sysco)) missing.sysco.push(`row ${r} Sysco text: ${sysco}`);
    } else if (isUsefulTerm(ref)) {
      stats.syscoFuzzyRef++;
      if (verifyEmptyPrimary && !vendorCsvMappingTermMatches(rawSysco, 'Sysco', ref)) {
        missing.sysco.push(`row ${r} Sysco (no alias — fuzzy ref): ${ref}`);
      }
    }

    if (isUsefulTerm(gfs)) {
      stats.gfsExplicit++;
      if (!vendorCsvMappingTermMatches(rawGfs, 'GFS', gfs)) missing.gfs.push(`row ${r} GFS text: ${gfs}`);
    } else if (isUsefulTerm(ref)) {
      stats.gfsFuzzyRef++;
      if (verifyEmptyPrimary && !vendorCsvMappingTermMatches(rawGfs, 'GFS', ref)) {
        missing.gfs.push(`row ${r} GFS (no alias — fuzzy ref): ${ref}`);
      }
    }
  }

  const hasMissing =
    missing.pfg.length + missing.sysco.length + missing.gfs.length > 0;

  const out = {
    stats,
    missing,
    mode: 'explicit-or-reference-fuzzy'
  };

  if (hasMissing) {
    const parts = [];
    if (missing.pfg.length) parts.push(`PFG (${missing.pfg.length}): ${missing.pfg.slice(0, 6).join(' | ')}${missing.pfg.length > 6 ? '…' : ''}`);
    if (missing.sysco.length) parts.push(`Sysco (${missing.sysco.length}): ${missing.sysco.slice(0, 6).join(' | ')}${missing.sysco.length > 6 ? '…' : ''}`);
    if (missing.gfs.length) parts.push(`GFS (${missing.gfs.length}): ${missing.gfs.slice(0, 6).join(' | ')}${missing.gfs.length > 6 ? '…' : ''}`);
    return {
      ok: false,
      message: `Mapping vs CSV checks failed.\n${parts.join('\n')}`,
      ...out
    };
  }

  return {
    ok: true,
    message:
      'Mapping rows verified: explicit B/D/E terms where present; otherwise some CSV product line fuzzy-matches the reference (same idea as server `matchProductName`).',
    ...out
  };
}

module.exports = {
  assertMappingTermsInDownloadedCsvs,
  findMissingTermsInCsvFile,
  extractProviderTermsFromWorksheet,
  normalizeForSearch,
  termMatchesInHaystack,
  loadWorkbookFromMappingUrlOrPath,
  fileDoesNotLookLikeCsv
};
