const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
require('dotenv').config();

/**
 * Login: username → **Next** → second screen: username + password → re-type last password char (Sysco quirk) → **Continue** → **Log in**.
 * List page more menu: try main page + every iframe — `button[data-id=more-actions-btn]` (one pointer click, no double click), then `menuitem` / `li[data-id=export-list-btn]`; JS `Element.click()` fallback in each context if Playwright is blocked.
 * Export list… → enable “Include pricing information” → Export → upload to localhost Biweekly Sysco input.
 *
 * Env:
 * - SYSCO_URL (optional; defaults to https://shop.sysco.com if unset)
 * - SYSCO_USERNAME
 * - SYSCO_PASSWORD
 * - SYSCO_LIST_REGEX (optional; JS RegExp source, default matches “New year new guide … '26”)
 * - PW_KEEP_OPEN=1 (optional)
 */
test('Sysco: export list CSV with pricing and upload to localhost', async ({ page, context }, testInfo) => {
  // Fail fast if the ⋮ click doesn't work (we rely on precise selectors, not long timeouts).
  test.setTimeout(3 * 60 * 1000);

  // Set viewport early so we don't hit it after a timeout closes the page.
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Capture only high-signal browser errors for debugging (auth/session issues cause infinite loaders).
  /** @type {string[]} */
  const importantConsole = [];
  page.on('console', (msg) => {
    const txt = msg.text() || '';
    if (
      /session could not be validated/i.test(txt) ||
      /\b401\b/.test(txt) ||
      /ApiCallError/i.test(txt) ||
      /Failed to load resource/i.test(txt)
    ) {
      importantConsole.push(`[console:${msg.type()}] ${txt}`);
    }
  });
  page.on('pageerror', (err) => {
    const txt = String(err && err.message ? err.message : err);
    if (/cannot read properties/i.test(txt) || /TypeError/i.test(txt)) {
      importantConsole.push(`[pageerror] ${txt}`);
    }
  });
  page.on('response', (resp) => {
    const status = resp.status();
    if (status === 401 || status === 403) {
      importantConsole.push(`[http ${status}] ${resp.url()}`);
    }
  });

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

  const downloadDir = testInfo.outputPath('downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const csvLikeResponsePredicate = (resp) => {
    try {
      const headers = resp.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      const cd = (headers['content-disposition'] || '').toLowerCase();
      const url = (resp.url() || '').toLowerCase();
      return (
        ct.includes('text/csv') ||
        ct.includes('application/csv') ||
        ct.includes('application/octet-stream') ||
        cd.includes('attachment') ||
        cd.includes('.csv') ||
        cd.includes('csv') ||
        url.includes('export')
      );
    } catch {
      return false;
    }
  };

  async function attemptExportOnce(exportButton, timeoutMs) {
    const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
    const responsePromise = page
      .waitForEvent('response', csvLikeResponsePredicate, { timeout: timeoutMs })
      .catch(() => null);

    await exportButton.click({ force: true });

    const never = () => new Promise(() => {});
    const downloadReady = downloadPromise.then((d) => (d ? { kind: 'download', download: d } : never()));
    const responseReady = responsePromise.then((r) => (r ? { kind: 'response', response: r } : never()));
    return /** @type {Promise<{kind:'download', download:any} | {kind:'response', response:any}>} */ (
      Promise.race([downloadReady, responseReady])
    );
  }

  async function exportWithRetries(exportButton) {
    let first = null;
    for (let i = 0; i < 6; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        first = await attemptExportOnce(exportButton, 8_000);
        break;
      } catch {
        // retry
      }
    }
    if (!first) first = await attemptExportOnce(exportButton, 180_000);
    return first;
  }

  /** “Lists” in the second horizontal band below the search box (Sysco uses `div.nav-link`, not link/button roles). */
  async function resolveListsSecondRowBelowSearch() {
    const searchInput = page
      .locator(
        'input[type="search"], input[type="text"][placeholder*="Search" i], input[type="text"][placeholder*="search" i], input[aria-label*="search" i], input[name*="search" i]'
      )
      .first();

    const listsNavLink = page
      .getByRole('link', { name: /^lists$/i })
      .or(page.getByRole('button', { name: /^lists$/i }));

    const listsNavDiv = page.locator('div.nav-link, .nav-link').filter({ hasText: /^\s*lists\s*$/i });

    const listsAll = listsNavLink.or(listsNavDiv);

    const fallback = listsNavDiv.or(listsNavLink).first();
    if (!(await searchInput.isVisible().catch(() => false))) return fallback;

    const sbox = await searchInput.boundingBox();
    if (!sbox) return fallback;

    const searchBottom = sbox.y + sbox.height;
    /** @type {Map<number, import('@playwright/test').Locator>} */
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

  // Login — screen 1: username only, then Next
  const userField = page
    .locator(
      'input[type="email"], input[name*="user" i], input[id*="user" i], input[id*="login" i], input[autocomplete="username"], input[name="loginfmt"]'
    )
    .first();

  await expect(userField).toBeVisible({ timeout: 45_000 });
  await userField.fill(username);

  const nextBtn = page
    .getByRole('button', { name: /^next$/i })
    .or(page.getByRole('button', { name: /^continue$/i }));

  await expect(nextBtn.first()).toBeVisible({ timeout: 25_000 });
  await nextBtn.first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Login — screen 2: username + password, then Log in
  const passField = page.locator('input[type="password"]').first();
  await expect(passField).toBeVisible({ timeout: 30_000 });

  const userField2 = page
    .locator(
      'input[type="email"], input[name="loginfmt"], input[id="i0116"], input[id*="signin" i], input[autocomplete="username"]'
    )
    .first();

  if (await userField2.isVisible({ timeout: 8_000 }).catch(() => false)) {
    const readonly = await userField2.getAttribute('readonly');
    const ariaReadonly = await userField2.getAttribute('aria-readonly');
    if (!readonly && ariaReadonly !== 'true') {
      await userField2.fill(username);
    }
  }

  await passField.fill(password);

  // Sysco quirk: must delete last character and re-enter it before Continue accepts the field
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

  const logIn = page
    .getByRole('button', { name: /^log in$/i })
    .or(page.getByRole('button', { name: /^sign in$/i }));

  await expect(logIn.first()).toBeVisible({ timeout: 25_000 });
  await logIn.first().click();

  // Avoid `networkidle` on Sysco (polling keeps the network busy and can burn the whole test timeout).
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // Dropdown row: “New Year New Guide '26” (custom regex via SYSCO_LIST_REGEX)
  const listChoice = page
    .getByRole('menuitem', { name: listLabelRe })
    .or(page.getByRole('option', { name: listLabelRe }))
    .or(page.locator('[role="menu"], [role="listbox"]').locator('a, button, li, div[role="option"]').filter({ hasText: listLabelRe }))
    .or(page.getByText(listLabelRe))
    .first();

  // Lists — second row below search; keep opening the Lists control until the dropdown / list row appears
  let listsMenuReady = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const listsNav = await resolveListsSecondRowBelowSearch();
    // eslint-disable-next-line no-await-in-loop
    await expect(listsNav).toBeVisible({ timeout: 35_000 });
    // eslint-disable-next-line no-await-in-loop
    await listsNav.click({ force: true });
    // eslint-disable-next-line no-await-in-loop
    await pause(550);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // eslint-disable-next-line no-await-in-loop
    const choiceVisible = await listChoice.isVisible({ timeout: 2_000 }).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    const menuChrome = await page
      .locator('[role="menu"], [role="listbox"], [data-popper-placement]')
      .first()
      .isVisible()
      .catch(() => false);

    if (choiceVisible || menuChrome) {
      listsMenuReady = true;
      break;
    }
  }

  expect(listsMenuReady, 'Lists dropdown should open after clicking Lists').toBe(true);
  await expect(listChoice).toBeVisible({ timeout: 20_000 });
  await listChoice.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Bring the list header (toolbar) into view; the ⋮ lives there, not in the rows.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.keyboard.press('Home').catch(() => {});

  // The list + ⋮ can live in an *iframe* — page.locator() / page.evaluate() only see the *main* frame, so
  // previous attempts often targeted nothing. We iterate every frame and use locators + click({ position }).
  // viewport already set above

  const listPageRoot = page
    .locator('.list-title-container-savings-enabled, .brand-conversion-title-container-tools')
    .first();
  await expect(listPageRoot).toBeVisible({ timeout: 45_000 });
  await expect(
    listPageRoot.locator('span.list-name, [data-id="list_header_name"]').first()
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  /**
   * @param {import('@playwright/test').Page} p
   */
  async function openMoreMenuAndClickExport(p) {
    /** @returns {Array<import('@playwright/test').Page | import('@playwright/test').Frame>} */
    const allContexts = () => [p, ...p.frames().filter((f) => f !== p.mainFrame())];

    const saneIconButton = (box) => box && box.width >= 10 && box.height >= 10 && box.width <= 240 && box.height <= 240;

    /** @param {import('@playwright/test').Page | import('@playwright/test').Frame} ctx */
    const moreCandidates = (ctx) =>
      ctx.locator(
        [
          // Material icon variants (most common on this page)
          'button:has(span.material-icons:has-text("more_vert"))',
          'button:has(i.material-icons:has-text("more_vert"))',
          'button:has([class*="material-icons"]:has-text("more_vert"))',
          // Accessible label variants
          'button[aria-label*="more" i]',
          'button[aria-label*="actions" i]',
          'button[title*="more" i]',
          // Data-id when present
          'button[data-id="more-actions-btn"]'
        ].join(', ')
      );

    const openMenuAndClickExportInContext = async (ctx) => {
      const cands = moreCandidates(ctx);
      const n = await cands.count().catch(() => 0);
      if (n === 0) return false;

      /** @type {import('@playwright/test').Locator | null} */
      let moreBtn = null;
      for (let i = 0; i < Math.min(n, 10); i++) {
        const b = cands.nth(i);
        // eslint-disable-next-line no-await-in-loop
        const box = await b.boundingBox().catch(() => null);
        if (!saneIconButton(box)) continue;
        // eslint-disable-next-line no-await-in-loop
        const vis = await b.isVisible().catch(() => false);
        if (!vis) continue;
        moreBtn = b;
        break;
      }
      if (!moreBtn) return false;

      await moreBtn.scrollIntoViewIfNeeded().catch(() => {});

      // Click like a user first (no force). If it fails, fall back to programmatic click.
      const clickOk =
        (await moreBtn.click({ timeout: 5000 }).then(() => true).catch(() => false)) ||
        (await moreBtn.evaluate((el) => el.click()).then(() => true).catch(() => false));

      if (!clickOk) return false;

      const exportItem = ctx
        .getByRole('menuitem', { name: /export\s*list/i })
        .or(ctx.locator('li[data-id="export-list-btn"]'))
        .or(ctx.getByText(/export\s*list/i))
        .first();

      const exportVisible = await exportItem.isVisible({ timeout: 5000 }).catch(() => false);
      if (!exportVisible) return false;

      await exportItem.click({ timeout: 4000 }).catch(async () => {
        await exportItem.evaluate((el) => el.click()).catch(() => {});
      });
      return true;
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      for (const ctx of allContexts()) {
        // eslint-disable-next-line no-await-in-loop
        if (await openMenuAndClickExportInContext(ctx)) return;
      }
      // eslint-disable-next-line no-await-in-loop
      await pause(350);
    }

    const mainCount = await moreCandidates(p).count().catch(() => 0);
    throw new Error(
      'Sysco: ⋮ menu did not open, or “Export List…” was not clickable. ' +
        `more-candidates(main-frame)=${mainCount}. ` +
        (importantConsole.length ? `Signals:\n- ${importantConsole.slice(-12).join('\n- ')}` : '')
    );
  }

  await openMoreMenuAndClickExport(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Include pricing — switch or checkbox
  const pricingSwitch = page.getByRole('switch', { name: /include pricing/i });
  if (await pricingSwitch.isVisible({ timeout: 12_000 }).catch(() => false)) {
    const checked = await pricingSwitch.getAttribute('aria-checked');
    if (checked !== 'true') await pricingSwitch.click({ force: true });
  } else {
    const pricingLabel = page.locator('label').filter({ hasText: /include pricing/i }).first();
    if (await pricingLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await pricingLabel.click({ force: true });
    }
  }

  const exportModal = page
    .locator('[role="dialog"], [role="alertdialog"]')
    .filter({ has: page.getByText(/export|pricing|include/i) })
    .last();

  const blueExport = (await exportModal.isVisible({ timeout: 4_000 }).catch(() => false))
    ? exportModal.getByRole('button', { name: /^export$/i }).first()
    : page
        .getByRole('button', { name: /^export$/i })
        .or(page.getByRole('button', { name: /export/i }))
        .filter({ hasNotText: /export list/i })
        .first();

  await expect(blueExport).toBeVisible({ timeout: 30_000 });

  let first = await exportWithRetries(blueExport);

  let targetPath;
  if (first.kind === 'download') {
    const suggested = first.download.suggestedFilename();
    targetPath = path.join(downloadDir, suggested.endsWith('.csv') ? suggested : 'sysco-list.csv');
    await first.download.saveAs(targetPath);
  } else {
    const body = await first.response.body();
    targetPath = path.join(downloadDir, 'sysco-list.csv');
    fs.writeFileSync(targetPath, body);
  }

  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Biweekly Order Providers' }).click();
  await page.waitForSelector('#biweekly-order.tab-content.active', { timeout: 15_000 });

  await page.locator('#biweeklySyscoInput').setInputFiles(targetPath);
  await expect(page.locator('#biweeklySyscoFileList')).toContainText('.csv', { timeout: 15_000 });

  if (process.env.PW_KEEP_OPEN === '1') {
    await context.waitForEvent('close', { timeout: 10 * 60 * 1000 }).catch(() => {});
  }
});
