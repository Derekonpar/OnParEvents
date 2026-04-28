const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
require('dotenv').config();

/**
 * GFS: login, export Order Guide CSV, upload to localhost Biweekly tab (GFS input).
 *
 * Login: username → Continue → password → Verify.
 * After login: delivery popup — click "Just browsing" only (left / white button with blue highlight), not Continue.
 * **Guides** is not in the top header: it lives in the row *below* the search box, on the left (we pick by layout: below search band, leftmost).
 * Next page: **Order guide (N products)** button (product count may change).
 * Retries with short pauses if navigation is flaky.
 *
 * Env vars (in .env):
 * - GFS_URL
 * - GFS_USERNAME
 * - GFS_PASSWORD
 *
 * Optional:
 * - PW_KEEP_OPEN=1  (keeps browser open briefly at end)
 */
test('GFS: export order guide CSV and upload to localhost', async ({ page, context }, testInfo) => {
  test.setTimeout(5 * 60 * 1000);

  let gfsUrl = process.env.GFS_URL || '';
  const username = process.env.GFS_USERNAME;
  const password = process.env.GFS_PASSWORD;

  expect(gfsUrl, 'Set GFS_URL env var').toBeTruthy();
  expect(username, 'Set GFS_USERNAME env var').toBeTruthy();
  expect(password, 'Set GFS_PASSWORD env var').toBeTruthy();

  if (!/^https?:\/\//i.test(gfsUrl)) {
    gfsUrl = `https://${gfsUrl}`;
  }

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
    const attempts = 6;
    for (let i = 0; i < attempts; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        first = await attemptExportOnce(exportButton, 8_000);
        break;
      } catch {
        // retry
      }
    }
    if (!first) {
      first = await attemptExportOnce(exportButton, 180_000);
    }
    return first;
  }

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * GFS puts **Guides** under the main header: in the strip *below* the search field, left side.
   * Choose the leftmost link/button/tab named "Guides" whose vertical center is below the search box bottom.
   */
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

  // 1) Login — username + Continue, then password + Verify
  await page.goto(gfsUrl, { waitUntil: 'domcontentloaded' });

  const userLocator = page.locator(
    'input[type="email"], input[name*=user i], input[id*=user i], input[name*=login i], input[id*=login i], input[type="text"]'
  );

  await expect(userLocator.first()).toBeVisible({ timeout: 30_000 });
  await userLocator.first().fill(username);

  const continueBtn = page
    .getByRole('button', { name: /^continue$/i })
    .or(page.getByRole('button', { name: /^next$/i }));

  await expect(continueBtn.first()).toBeVisible({ timeout: 20_000 });
  await continueBtn.first().click();
  await page.waitForLoadState('domcontentloaded');

  const passLocator = page.locator('input[type="password"]').first();
  await expect(passLocator).toBeVisible({ timeout: 30_000 });
  await passLocator.fill(password);

  const verifyBtn = page.getByRole('button', { name: /^verify$/i });

  await expect(verifyBtn).toBeVisible({ timeout: 20_000 });
  await verifyBtn.click();
  await page.waitForLoadState('networkidle');

  // 2) Post-login delivery popup: must click "Just browsing" (not Continue — Continue is the other action)
  const justBrowsingInDialog = page
    .locator('[role="dialog"], [role="alertdialog"]')
    .first()
    .locator('button, a[role="button"]')
    .filter({ hasText: /just browsing/i });

  const justBrowsingAnywhere = page
    .getByRole('button', { name: /just browsing/i })
    .or(page.getByRole('link', { name: /just browsing/i }))
    .or(page.locator('button, a').filter({ hasText: /^\s*just browsing\s*$/i }));

  for (let attempt = 0; attempt < 10; attempt++) {
    const inDialog = justBrowsingInDialog.first();
    const anywhere = justBrowsingAnywhere.first();
    // eslint-disable-next-line no-await-in-loop
    const target = (await inDialog.isVisible().catch(() => false)) ? inDialog : anywhere;
    // eslint-disable-next-line no-await-in-loop
    const visible = await target.isVisible().catch(() => false);
    if (!visible) {
      // eslint-disable-next-line no-await-in-loop
      await pause(400);
      // eslint-disable-next-line no-await-in-loop
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await target.click({ force: true });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    const stillThere = await target.isVisible().catch(() => false);
    if (!stillThere) break;
    // eslint-disable-next-line no-await-in-loop
    await pause(500);
  }

  // 3) Guides — row below search (left); re-resolve each attempt in case layout shifts
  // Order guide entry shows product count, e.g. "Order guide (147 products)"
  const orderGuideCountRe = /order guide\s*\(\d+\s*(products?|items?)\)/i;
  const orderGuideWithCount = page
    .getByRole('button', { name: orderGuideCountRe })
    .or(page.getByRole('link', { name: orderGuideCountRe }))
    .or(page.locator('a,button').filter({ hasText: orderGuideCountRe }));

  const orderGuide = orderGuideWithCount
    .or(page.getByRole('button', { name: /order guide/i }))
    .or(page.getByRole('link', { name: /order guide/i }))
    .or(page.locator('a,button').filter({ hasText: /order guide/i }))
    .first();

  const guidesNav0 = await resolveGuidesBelowSearch();
  await expect(guidesNav0).toBeVisible({ timeout: 30_000 });

  for (let attempt = 0; attempt < 12; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await orderGuide.isVisible().catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    const guidesNav = await resolveGuidesBelowSearch();
    // eslint-disable-next-line no-await-in-loop
    await guidesNav.click({ force: true });
    // eslint-disable-next-line no-await-in-loop
    await pause(700);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await expect(orderGuide).toBeVisible({ timeout: 20_000 });

  // 4) Order guide — same retry pattern until Export is available
  const exportButton1 = page
    .getByRole('button', { name: /^export$/i })
    .or(page.getByRole('link', { name: /^export$/i }))
    .first();

  for (let attempt = 0; attempt < 12; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await exportButton1.isVisible().catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await orderGuide.click({ force: true });
    // eslint-disable-next-line no-await-in-loop
    await pause(700);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  // 5) Export (first page)
  await expect(exportButton1).toBeVisible({ timeout: 30_000 });
  let first = await exportWithRetries(exportButton1);

  // 6) Blue export confirmation (second Export)
  const exportButton2 = page.getByRole('button', { name: /^export$/i }).or(page.getByRole('link', { name: /^export$/i })).first();
  if (await exportButton2.isVisible({ timeout: 5_000 }).catch(() => false)) {
    first = await exportWithRetries(exportButton2);
  }

  let targetPath;
  if (first.kind === 'download') {
    const suggested = first.download.suggestedFilename();
    targetPath = path.join(downloadDir, suggested.endsWith('.csv') ? suggested : 'gfs-order-guide.csv');
    await first.download.saveAs(targetPath);
  } else {
    const body = await first.response.body();
    targetPath = path.join(downloadDir, 'gfs-order-guide.csv');
    fs.writeFileSync(targetPath, body);
  }

  // 7) Upload to localhost Biweekly → GFS
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Biweekly Order Providers' }).click();
  await page.waitForSelector('#biweekly-order.tab-content.active', { timeout: 15_000 });

  const gfsInput = page.locator('#biweeklyGfsInput');
  await gfsInput.setInputFiles(targetPath);

  const gfsFileList = page.locator('#biweeklyGfsFileList');
  await expect(gfsFileList).toContainText('.csv', { timeout: 15_000 });

  if (process.env.PW_KEEP_OPEN === '1') {
    await context.waitForEvent('close', { timeout: 10 * 60 * 1000 }).catch(() => {});
  }
});
