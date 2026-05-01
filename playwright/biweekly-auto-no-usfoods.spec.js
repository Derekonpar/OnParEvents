const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { assertMappingTermsInDownloadedCsvs, fileDoesNotLookLikeCsv } = require('./lib/mapping-csv-term-verify');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Biweekly Auto (No US Foods):
 * - Downloads PFG + Sysco + GFS provider CSVs in one Playwright run
 * - Opens localhost and uploads them into "Biweekly Order Automation (No US Foods)"
 * - Checks "Use Google Sheets" (inventory + mapping fetched server-side)
 * - Clicks "Generate Order Plan" and waits for recommendations
 *
 * Preconditions:
 * - `npm start` is already running (http://localhost:3000)
 * - `.env` has vendor creds and BIWEEKLY_*_SHEET_URL export links
 */
test('Biweekly Auto: download provider CSVs and generate order plan (no US foods)', async ({ browser }, testInfo) => {
  // Full end-to-end vendor run can exceed 8 minutes (vendor sites + downloads + localhost processing).
  test.setTimeout(12 * 60 * 1000);

  // Fresh state each run: new context means no cookies/localStorage from any prior run.
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  });

  const downloadDir = testInfo.outputPath('downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Only used if the browser never fires `download`. Must not match JSON APIs or ad pixels. */
  function strictCsvExportResponse(resp) {
    try {
      if (!resp.ok()) return false;
      const url = (resp.url() || '').toLowerCase();
      if (
        /pagead|doubleclick|googleadservices|googletagmanager|google-analytics|facebook\.com\/tr|\/collect\?/i.test(url)
      ) {
        return false;
      }
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
      if (ct.includes('json')) return false;
      if (ct.includes('html')) return false;
      if (ct.includes('javascript')) return false;
      if (ct.includes('text/csv') || ct.includes('application/csv')) return true;
      if (cd.includes('.csv') || cd.includes('filename*=utf-8')) return ct.includes('octet-stream') || ct.includes('binary');
      return false;
    } catch {
      return false;
    }
  }

  function validateSavedCsvFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 12000);
    if (fileDoesNotLookLikeCsv(raw)) {
      throw new Error(
        `Saved file is not a vendor CSV (got JSON/HTML/JS or noise). Try export again or check download dialog. File: ${filePath}`
      );
    }
  }

  /**
   * Prefer real browser downloads (matches manual "Save file"). Avoid racing loose HTTP responses —
   * that often captures API JSON (PFG) or tracking JS (GFS) before the CSV.
   */
  async function saveExportToFile(page, exportButton, fallbackName) {
    for (const timeoutMs of [90_000, 180_000, 240_000]) {
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
        await exportButton.click({ force: true });
        // eslint-disable-next-line no-await-in-loop
        const download = await downloadPromise;
        const suggested = download.suggestedFilename() || '';
        const out = path.join(downloadDir, /\.csv$/i.test(suggested) ? suggested : fallbackName);
        // eslint-disable-next-line no-await-in-loop
        await download.saveAs(out);
        // eslint-disable-next-line no-await-in-loop
        validateSavedCsvFile(out);
        return out;
      } catch {
        // eslint-disable-next-line no-await-in-loop
        await pause(600);
      }
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    const responsePromise = page.waitForEvent('response', strictCsvExportResponse, { timeout: 180_000 });
    await exportButton.click({ force: true });
    const settled = await Promise.allSettled([downloadPromise, responsePromise]);
    const download = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const resp = settled[1].status === 'fulfilled' ? settled[1].value : null;

    if (download) {
      const suggested = download.suggestedFilename() || '';
      const out = path.join(downloadDir, /\.csv$/i.test(suggested) ? suggested : fallbackName);
      await download.saveAs(out);
      validateSavedCsvFile(out);
      return out;
    }

    if (resp) {
      const buf = await resp.body();
      const head = buf.slice(0, Math.min(buf.length, 800)).toString('utf8');
      if (fileDoesNotLookLikeCsv(head)) {
        throw new Error(`HTTP response was not CSV (${resp.url()}): ${head.slice(0, 120)}`);
      }
      const out = path.join(downloadDir, fallbackName);
      fs.writeFileSync(out, buf);
      validateSavedCsvFile(out);
      return out;
    }

    throw new Error(`Could not capture CSV for ${fallbackName} (no download event and no CSV HTTP response)`);
  }

  async function downloadPfgCsv() {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const pfgUrl = process.env.PFG_URL;
    const username = process.env.PFG_USERNAME;
    const password = process.env.PFG_PASSWORD;
    expect(pfgUrl, 'Set PFG_URL env var').toBeTruthy();
    expect(username, 'Set PFG_USERNAME env var').toBeTruthy();
    expect(password, 'Set PFG_PASSWORD env var').toBeTruthy();

    await page.goto(pfgUrl, { waitUntil: 'domcontentloaded' });

    const userLocator = page.locator(
      'input[type="email"], input[name*=user i], input[id*=user i], input[name*=login i], input[id*=login i], input[type="text"]'
    );
    const passLocator = page.locator('input[type="password"]');
    await expect(userLocator.first()).toBeVisible({ timeout: 45_000 });
    await userLocator.first().fill(username);
    await expect(passLocator.first()).toBeVisible({ timeout: 45_000 });
    await passLocator.first().fill(password);

    const submit = page.locator('button[type="submit"], input[type="submit"]');
    if (await submit.count()) await submit.first().click();
    else await page.keyboard.press('Enter');

    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const listsTopNav = page.getByRole('link', { name: 'Lists' }).or(page.getByRole('button', { name: 'Lists' }));
    await expect(listsTopNav.first()).toBeVisible({ timeout: 45_000 });
    await listsTopNav.first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const fallListLink = page.getByRole('link', { name: /FALL 2025/i }).or(page.locator('text=FALL 2025').first());
    await expect(fallListLink.first()).toBeVisible({ timeout: 45_000 });
    await fallListLink.first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const manageListBtn = page.getByRole('button', { name: /manage list/i });
    await expect(manageListBtn).toBeVisible({ timeout: 45_000 });
    const kebab = manageListBtn.locator('xpath=following::button[1]');
    await expect(kebab).toBeVisible({ timeout: 45_000 });
    await kebab.click();

    const exportMenuItem = page
      .locator('[role="menu"] >> text=Export')
      .first()
      .or(page.locator('text=Export').first());
    await expect(exportMenuItem).toBeVisible({ timeout: 45_000 });

    // PFG: the first Export opens a modal; the modal's blue Export triggers the download.
    let blueExport = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      await exportMenuItem.click({ timeout: 8000 }).catch(async () => {
        await exportMenuItem.evaluate((el) => el.click()).catch(() => {});
      });
      // eslint-disable-next-line no-await-in-loop
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      const exportModal = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ has: page.getByText(/export/i) })
        .last();
      const modalBtn = exportModal.getByRole('button', { name: /^export$/i }).first();
      // eslint-disable-next-line no-await-in-loop
      if (await modalBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        blueExport = modalBtn;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await pause(500);
    }

    if (!blueExport) {
      blueExport = page.getByRole('button', { name: /^export$/i }).or(page.getByRole('button', { name: /export/i })).first();
    }

    await expect(blueExport).toBeVisible({ timeout: 45_000 });
    const out = await saveExportToFile(page, blueExport, 'pfg-order-guide.csv');
    await page.close().catch(() => {});
    return out;
  }

  async function downloadGfsCsv() {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    let gfsUrl = process.env.GFS_URL || '';
    const username = process.env.GFS_USERNAME;
    const password = process.env.GFS_PASSWORD;
    expect(gfsUrl, 'Set GFS_URL env var').toBeTruthy();
    expect(username, 'Set GFS_USERNAME env var').toBeTruthy();
    expect(password, 'Set GFS_PASSWORD env var').toBeTruthy();
    if (!/^https?:\/\//i.test(gfsUrl)) gfsUrl = `https://${gfsUrl}`;

    const orderGuideCountRe = /order guide\s*\(\d+\s*(products?|items?)\)/i;
    const pauseShort = () => pause(650);

    async function resolveGuidesBelowSearch() {
      const searchInput = page
        .locator(
          'input[type="search"], input[type="text"][placeholder*="Search" i], input[type="text"][placeholder*="search" i], input[aria-label*="search" i], input[name*="search" i]'
        )
        .first();
      const fallback = page
        .getByRole('link', { name: /^guides$/i })
        .or(page.getByRole('button', { name: /^guides$/i }))
        .or(page.getByRole('tab', { name: /^guides$/i }))
        .first();
      if (!(await searchInput.isVisible().catch(() => false))) return fallback;
      const sbox = await searchInput.boundingBox();
      if (!sbox) return fallback;
      const searchBottom = sbox.y + sbox.height;
      let best = null;
      let bestX = Infinity;
      for (const role of ['link', 'button', 'tab']) {
        const loc = page.getByRole(role, { name: /^guides$/i });
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          // eslint-disable-next-line no-await-in-loop
          const box = await el.boundingBox();
          if (!box) continue;
          const midY = box.y + box.height / 2;
          if (midY < searchBottom - 2) continue;
          if (box.x < bestX) {
            bestX = box.x;
            best = el;
          }
        }
      }
      return best ?? fallback;
    }

    await page.goto(gfsUrl, { waitUntil: 'domcontentloaded' });

    const userLocator = page.locator(
      'input[type="email"], input[name*=user i], input[id*=user i], input[name*=login i], input[id*=login i], input[type="text"]'
    );
    await expect(userLocator.first()).toBeVisible({ timeout: 45_000 });
    await userLocator.first().fill(username);

    const continueBtn = page.getByRole('button', { name: /^continue$/i }).or(page.getByRole('button', { name: /^next$/i }));
    await expect(continueBtn.first()).toBeVisible({ timeout: 30_000 });
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const passLocator = page.locator('input[type="password"]').first();
    await expect(passLocator).toBeVisible({ timeout: 45_000 });
    await passLocator.fill(password);

    const verifyBtn = page.getByRole('button', { name: /^verify$/i });
    await expect(verifyBtn).toBeVisible({ timeout: 30_000 });
    await verifyBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    async function dismissJustBrowsingModal({ maxMs = 90_000 } = {}) {
      const started = Date.now();
      const buttonTextRe = /^\s*just browsing\s*$/i;
      const anyTextRe = /just browsing/i;
      let misses = 0;

      async function clickInScope(scope) {
        // Some GFS modals do not set aria roles; prefer semantic roles but also fall back to text-only selectors.
        const anywhere = scope
          .getByRole('button', { name: buttonTextRe })
          .or(scope.getByRole('button', { name: anyTextRe }))
          .or(scope.getByRole('link', { name: anyTextRe }))
          .or(scope.locator('button, a, [role="button"]').filter({ hasText: buttonTextRe }))
          .or(scope.locator('button, a, [role="button"]').filter({ hasText: anyTextRe }))
          .first();

        const target = anywhere;
        if (!(await target.isVisible().catch(() => false))) return false;

        await target
          .click({ force: true, timeout: 3000 })
          .catch(async () => {
            await target.evaluate((el) => el.click()).catch(() => {});
          });
        return true;
      }

      while (Date.now() - started < maxMs) {
        // Try main page
        // eslint-disable-next-line no-await-in-loop
        const clickedPage = await clickInScope(page);

        // Try all frames (some GFS popups render inside an iframe)
        let clickedFrame = false;
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          // eslint-disable-next-line no-await-in-loop
          const did = await clickInScope(f).catch(() => false);
          if (did) clickedFrame = true;
        }

        if (!clickedPage && !clickedFrame) {
          misses++;
        } else {
          misses = 0;
        }

        // If we haven't seen the modal for a short while, stop waiting.
        if (misses >= 6) break;
        // eslint-disable-next-line no-await-in-loop
        await pause(600);
      }
    }

    await dismissJustBrowsingModal({ maxMs: 90_000 }).catch(() => {});

    const orderGuide = page
      .getByRole('button', { name: orderGuideCountRe })
      .or(page.getByRole('link', { name: orderGuideCountRe }))
      .or(page.locator('a,button').filter({ hasText: orderGuideCountRe }))
      .or(page.getByRole('button', { name: /order guide/i }))
      .or(page.getByRole('link', { name: /order guide/i }))
      .or(page.locator('a,button').filter({ hasText: /order guide/i }))
      .first();

    for (let attempt = 0; attempt < 12; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      if (await orderGuide.isVisible().catch(() => false)) break;
      // eslint-disable-next-line no-await-in-loop
      await dismissJustBrowsingModal({ maxMs: 6000 }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const guidesNav = await resolveGuidesBelowSearch();
      // eslint-disable-next-line no-await-in-loop
      await guidesNav.click({ force: true }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await pauseShort();
    }
    await expect(orderGuide).toBeVisible({ timeout: 45_000 });

    const exportButton1 = page.getByRole('button', { name: /^export$/i }).or(page.getByRole('link', { name: /^export$/i })).first();
    for (let attempt = 0; attempt < 12; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      if (await exportButton1.isVisible().catch(() => false)) break;
      // eslint-disable-next-line no-await-in-loop
      await dismissJustBrowsingModal({ maxMs: 6000 }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await orderGuide.click({ force: true }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await pauseShort();
    }
    await expect(exportButton1).toBeVisible({ timeout: 45_000 });

    // GFS: clicking Export often opens a modal with a second blue "Export" button that triggers the download.
    await exportButton1.click({ force: true }).catch(async () => {
      await exportButton1.evaluate((el) => el.click()).catch(() => {});
    });
    await dismissJustBrowsingModal({ maxMs: 8000 }).catch(() => {});

    const exportModal = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ has: page.getByText(/export/i) })
      .last();
    const blueExport = (await exportModal.isVisible({ timeout: 6_000 }).catch(() => false))
      ? exportModal.getByRole('button', { name: /^export$/i }).first()
      : page.getByRole('button', { name: /^export$/i }).first();

    await expect(blueExport).toBeVisible({ timeout: 45_000 });
    const out = await saveExportToFile(page, blueExport, 'gfs-order-guide.csv');
    await page.close().catch(() => {});
    return out;
  }

  async function downloadSyscoCsv() {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    let syscoUrl = (process.env.SYSCO_URL || '').trim();
    const username = process.env.SYSCO_USERNAME;
    const password = process.env.SYSCO_PASSWORD;
    expect(username, 'Set SYSCO_USERNAME in .env').toBeTruthy();
    expect(password, 'Set SYSCO_PASSWORD in .env').toBeTruthy();
    if (!syscoUrl) syscoUrl = 'https://shop.sysco.com';
    if (!/^https?:\/\//i.test(syscoUrl)) syscoUrl = `https://${syscoUrl}`;

    const listLabelRe = process.env.SYSCO_LIST_REGEX
      ? new RegExp(process.env.SYSCO_LIST_REGEX, 'i')
      : /new\s+year\s+new\s+guide[\s\S]{0,48}?['\u2019']?26\b/i;

    async function resolveListsSecondRowBelowSearch() {
      const searchInput = page
        .locator(
          'input[type="search"], input[type="text"][placeholder*="Search" i], input[type="text"][placeholder*="search" i], input[aria-label*="search" i], input[name*="search" i]'
        )
        .first();
      const listsNavLink = page.getByRole('link', { name: /^lists$/i }).or(page.getByRole('button', { name: /^lists$/i }));
      const listsNavDiv = page.locator('div.nav-link, .nav-link').filter({ hasText: /^\s*lists\s*$/i });
      const listsAll = listsNavLink.or(listsNavDiv);
      const fallback = listsNavDiv.or(listsNavLink).first();
      if (!(await searchInput.isVisible().catch(() => false))) return fallback;
      const sbox = await searchInput.boundingBox();
      if (!sbox) return fallback;
      const searchBottom = sbox.y + sbox.height;
      const bandToEl = new Map();
      const n = await listsAll.count();
      for (let i = 0; i < n; i++) {
        const el = listsAll.nth(i);
        // eslint-disable-next-line no-await-in-loop
        const box = await el.boundingBox();
        if (!box) continue;
        const midY = box.y + box.height / 2;
        if (midY < searchBottom - 4) continue;
        const band = Math.round(midY / 16);
        if (!bandToEl.has(band)) bandToEl.set(band, el);
      }
      const bands = [...bandToEl.entries()].sort((a, b) => a[0] - b[0]);
      if (bands.length >= 2) return bands[1][1];
      if (bands.length === 1) return bands[0][1];
      return fallback;
    }

    await page.goto(syscoUrl, { waitUntil: 'domcontentloaded' });

    const userField = page
      .locator(
        'input[type="email"], input[name*="user" i], input[id*="user" i], input[id*="login" i], input[autocomplete="username"], input[name="loginfmt"]'
      )
      .first();
    await expect(userField).toBeVisible({ timeout: 60_000 });
    await userField.fill(username);

    const nextBtn = page.getByRole('button', { name: /^next$/i }).or(page.getByRole('button', { name: /^continue$/i }));
    await expect(nextBtn.first()).toBeVisible({ timeout: 30_000 });
    await nextBtn.first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const passField = page.locator('input[type="password"]').first();
    await expect(passField).toBeVisible({ timeout: 45_000 });

    const userField2 = page
      .locator('input[type="email"], input[name="loginfmt"], input[id="i0116"], input[id*="signin" i], input[autocomplete="username"]')
      .first();
    if (await userField2.isVisible({ timeout: 6_000 }).catch(() => false)) {
      const readonly = await userField2.getAttribute('readonly');
      const ariaReadonly = await userField2.getAttribute('aria-readonly');
      if (!readonly && ariaReadonly !== 'true') await userField2.fill(username);
    }

    await passField.fill(password);
    if (password.length > 0) {
      await passField.click();
      await passField.press('Backspace');
      await page.keyboard.type(password.slice(-1), { delay: 40 });
    }

    const continueAfterPw = page.getByRole('button', { name: /^continue$/i });
    if (await continueAfterPw.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await continueAfterPw.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    const logIn = page.getByRole('button', { name: /^log in$/i }).or(page.getByRole('button', { name: /^sign in$/i }));
    await expect(logIn.first()).toBeVisible({ timeout: 30_000 });
    await logIn.first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const listChoice = page
      .getByRole('menuitem', { name: listLabelRe })
      .or(page.getByRole('option', { name: listLabelRe }))
      .or(page.locator('[role="menu"], [role="listbox"]').locator('a, button, li, div[role="option"]').filter({ hasText: listLabelRe }))
      .or(page.getByText(listLabelRe))
      .first();

    let listsMenuReady = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const listsNav = await resolveListsSecondRowBelowSearch();
      // eslint-disable-next-line no-await-in-loop
      await expect(listsNav).toBeVisible({ timeout: 45_000 });
      // eslint-disable-next-line no-await-in-loop
      await listsNav.click({ force: true });
      // eslint-disable-next-line no-await-in-loop
      await pause(550);
      // eslint-disable-next-line no-await-in-loop
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const choiceVisible = await listChoice.isVisible({ timeout: 2_000 }).catch(() => false);
      if (choiceVisible) {
        listsMenuReady = true;
        break;
      }
    }
    expect(listsMenuReady, 'Sysco: Lists dropdown should open').toBe(true);

    await expect(listChoice).toBeVisible({ timeout: 45_000 });
    await listChoice.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.keyboard.press('Home').catch(() => {});

    const moreCandidates = (ctx) =>
      ctx.locator(
        [
          'button:has(span.material-icons:has-text("more_vert"))',
          'button:has(i.material-icons:has-text("more_vert"))',
          'button:has([class*="material-icons"]:has-text("more_vert"))',
          'button[aria-label*="more" i]',
          'button[aria-label*="actions" i]',
          'button[title*="more" i]',
          'button[data-id="more-actions-btn"]'
        ].join(', ')
      );

    const allContexts = () => [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    const saneIconButton = (box) => box && box.width >= 10 && box.height >= 10 && box.width <= 240 && box.height <= 240;

    let opened = false;
    let lastExportItem = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const ctx of allContexts()) {
        const cands = moreCandidates(ctx);
        const n = await cands.count().catch(() => 0);
        if (n === 0) continue;
        let btn = null;
        for (let i = 0; i < Math.min(n, 10); i++) {
          const b = cands.nth(i);
          // eslint-disable-next-line no-await-in-loop
          const box = await b.boundingBox().catch(() => null);
          if (!saneIconButton(box)) continue;
          // eslint-disable-next-line no-await-in-loop
          const vis = await b.isVisible().catch(() => false);
          if (!vis) continue;
          btn = b;
          break;
        }
        if (!btn) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        const clickOk =
          (await btn.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
          (await btn.evaluate((el) => el.click()).then(() => true).catch(() => false));
        if (!clickOk) continue;
        opened = true;
        // click export item
        const exportItem = ctx
          .getByRole('menuitem', { name: /export\s*list/i })
          .or(ctx.locator('li[data-id="export-list-btn"]'))
          .or(ctx.getByText(/export\s*list/i))
          .first();
        if (await exportItem.isVisible({ timeout: 6000 }).catch(() => false)) {
          lastExportItem = exportItem;
          // Sysco can open the dropdown but ignore the menu-item click. Retry until we see export UI.
          const exportUiVisible = async () => {
            const pricing = page.getByRole('switch', { name: /include pricing/i });
            if (await pricing.isVisible({ timeout: 800 }).catch(() => false)) return true;
            const modal = page
              .locator('[role="dialog"], [role="alertdialog"]')
              .filter({ hasText: /export|pricing|include/i })
              .last();
            if (await modal.isVisible({ timeout: 800 }).catch(() => false)) return true;
            const exportBtn = page.getByRole('button', { name: /^export$/i });
            if (await exportBtn.isVisible({ timeout: 800 }).catch(() => false)) return true;
            return false;
          };

          for (let clickAttempt = 0; clickAttempt < 4; clickAttempt++) {
            // eslint-disable-next-line no-await-in-loop
            const ok =
              (await exportItem.click({ timeout: 4000 }).then(() => true).catch(() => false)) ||
              (await exportItem.evaluate((el) => el.click()).then(() => true).catch(() => false));
            if (!ok) {
              // eslint-disable-next-line no-await-in-loop
              const box = await exportItem.boundingBox().catch(() => null);
              if (box) {
                // eslint-disable-next-line no-await-in-loop
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
              }
            }
            // eslint-disable-next-line no-await-in-loop
            await pause(700);
            // eslint-disable-next-line no-await-in-loop
            if (await exportUiVisible()) {
              opened = true;
              break;
            }
          }

          if (opened) break;
        }
      }
      if (opened) break;
      // eslint-disable-next-line no-await-in-loop
      await pause(400);
    }

    // Include pricing (best-effort)
    const pricingSwitch = page.getByRole('switch', { name: /include pricing/i });
    if (await pricingSwitch.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const checked = await pricingSwitch.getAttribute('aria-checked');
      if (checked !== 'true') await pricingSwitch.click({ force: true });
    } else {
      const pricingLabel = page.locator('label').filter({ hasText: /include pricing/i }).first();
      if (await pricingLabel.isVisible({ timeout: 4_000 }).catch(() => false)) await pricingLabel.click({ force: true });
    }

    // Sysco sometimes shows a modal with a second Export button; other times export can be triggered by clicking
    // the "Export list" menu item again. Prefer modal Export when present; otherwise fall back to the last menu item.
    let blueExport = null;
    for (const ctx of allContexts()) {
      const modal = ctx
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ hasText: /export|pricing|include/i })
        .last();
      const btn = modal
        .getByRole('button', { name: /^export$/i })
        .or(modal.getByRole('button', { name: /export\s*list/i }))
        .or(modal.getByRole('button', { name: /download/i }))
        .or(modal.locator('button').filter({ hasText: /^\s*export\s*$/i }))
        .first();
      // eslint-disable-next-line no-await-in-loop
      if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
        blueExport = btn;
        break;
      }
    }

    let clickTarget = blueExport || lastExportItem;

    if (!clickTarget) {
      for (const ctx of allContexts()) {
        const candidate = ctx
          .getByRole('menuitem', { name: /export\s*list/i })
          .or(ctx.locator('li[data-id="export-list-btn"]'))
          .or(ctx.getByRole('button', { name: /^export$/i }))
          .or(ctx.getByRole('button', { name: /export\s*list/i }))
          .or(ctx.getByText(/^\s*export\s*list\s*$/i))
          .first();
        // eslint-disable-next-line no-await-in-loop
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          clickTarget = candidate;
          break;
        }
      }
    }

    if (!clickTarget) {
      throw new Error(
        'Sysco: could not locate an Export / Export list button on page or any frame. The kebab menu likely never opened.'
      );
    }

    await expect(clickTarget, 'Could not find Sysco Export button/menu item').toBeVisible({ timeout: 45_000 });
    const out = await saveExportToFile(page, clickTarget, 'sysco-list.csv');
    await page.close().catch(() => {});
    return out;
  }

  const pfgPath = await test.step('Download PFG CSV', async () => await downloadPfgCsv());
  const syscoPath = await test.step('Download Sysco CSV', async () => await downloadSyscoCsv());
  const gfsPath = await test.step('Download GFS CSV', async () => await downloadGfsCsv());

  await test.step('Sanity check: saved downloads are real CSVs', async () => {
    const rawGfs = fs.readFileSync(gfsPath, 'utf8').slice(0, 12000);
    expect(fileDoesNotLookLikeCsv(rawGfs), `GFS download did not look like CSV. First bytes: ${rawGfs.slice(0, 180)}`).toBe(
      false
    );
  });

  // Playwright puts each run under test-results/.../ — print full paths so you can copy into .env for `npm run pw:verify-mapping`
  const downloadEnvBlock = `PFG_CSV=${pfgPath}\nSYSCO_CSV=${syscoPath}\nGFS_CSV=${gfsPath}`;
  // eslint-disable-next-line no-console
  console.log(
    `\n[biweekly] Downloaded CSVs (absolute paths). Add to project .env to re-run mapping check without re-login:\n\n${downloadEnvBlock}\n`
  );
  await testInfo.attach('env-for-pw-verify-mapping.txt', { body: downloadEnvBlock, contentType: 'text/plain' });

  await test.step('Verify downloads vs mapping (explicit B/D/E, else fuzzy reference)', async () => {
    const mapUrl = (process.env.BIWEEKLY_MAPPING_SHEET_URL || '').trim();
    if (!mapUrl) {
      test.info().annotations.push({ type: 'note', description: 'Skip mapping vs CSV check: set BIWEEKLY_MAPPING_SHEET_URL' });
      return;
    }

    function pathLooksLikeCsv(p) {
      const raw = fs.readFileSync(p, 'utf8').slice(0, 12000);
      return !fileDoesNotLookLikeCsv(raw);
    }

    const filesOk = pathLooksLikeCsv(pfgPath) && pathLooksLikeCsv(syscoPath) && pathLooksLikeCsv(gfsPath);
    if (!filesOk) {
      const msg =
        'Skipped mapping-term search: one or more saved files are not real CSVs (often JSON settings or JS from a mis-captured network response). Prefer the browser download event for the actual export file.';
      // eslint-disable-next-line no-console
      console.warn(`[biweekly] ${msg}`);
      test.info().annotations.push({ type: 'warning', description: msg });
      return;
    }

    const v = await assertMappingTermsInDownloadedCsvs({
      mappingUrl: mapUrl,
      pfgPath,
      syscoPath,
      gfsPath
    });
    // eslint-disable-next-line no-console
    console.log('[mapping check]', v.stats);

    const strict = (process.env.PW_MAPPING_VERIFY_STRICT || '').trim() === '1';
    if (strict) {
      expect(v.ok, v.message).toBe(true);
    } else if (!v.ok) {
      const note =
        'Mapping vs export wording differs for some rows (expected with live catalogs). Set PW_MAPPING_VERIFY_STRICT=1 to fail the run on this check; PW_MAPPING_VERIFY_EMPTY_PRIMARY=1 also validates rows with empty B/D/E via fuzzy ref.';
      // eslint-disable-next-line no-console
      console.warn(`[biweekly] ${note}\n${v.message}`);
      test.info().annotations.push({ type: 'warning', description: `${note}\n${v.message}`.slice(0, 8000) });
      await testInfo.attach('mapping-verify-soft-fail.txt', {
        body: `${v.message}\n\n${note}`,
        contentType: 'text/plain'
      });
    }
  });

  await test.step('Upload CSVs to localhost and generate plan', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /biweekly order automation/i }).click();
    await page.waitForSelector('#biweekly-order-auto.tab-content.active', { timeout: 15_000 });

    await page.locator('#biweeklyAutoUseSheets').check({ force: true });

    await page.locator('#biweeklyAutoPfgInput').setInputFiles(pfgPath);
    await page.locator('#biweeklyAutoSyscoInput').setInputFiles(syscoPath);
    await page.locator('#biweeklyAutoGfsInput').setInputFiles(gfsPath);

    await expect(page.locator('#biweeklyAutoPfgFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklyAutoSyscoFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklyAutoGfsFileList')).toContainText('.csv', { timeout: 10_000 });

    const btn = page.locator('#biweeklyAutoProcessButton');
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();

    const results = page.locator('#biweeklyAutoResults');
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results).toContainText(/recommendations/i, { timeout: 60_000 });

    if (process.env.PW_KEEP_OPEN === '1') {
      await context.waitForEvent('close', { timeout: 10 * 60 * 1000 }).catch(() => {});
    }
  });

  await context.close().catch(() => {});
});

