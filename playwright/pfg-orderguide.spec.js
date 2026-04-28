const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
require('dotenv').config();

/**
 * This test is intentionally interactive/headed by default:
 * - It logs into PFG and downloads the order guide CSV
 * - Then uploads it into the localhost UI biweekly PFG file input
 *
 * Required env vars:
 * - PFG_URL (login or landing page)
 * - PFG_USERNAME
 * - PFG_PASSWORD
 */
test('PFG: download order guide CSV and upload to localhost', async ({ page, context }, testInfo) => {
  test.setTimeout(5 * 60 * 1000);
  const pfgUrl = process.env.PFG_URL;
  const username = process.env.PFG_USERNAME;
  const password = process.env.PFG_PASSWORD;

  expect(pfgUrl, 'Set PFG_URL env var').toBeTruthy();
  expect(username, 'Set PFG_USERNAME env var').toBeTruthy();
  expect(password, 'Set PFG_PASSWORD env var').toBeTruthy();

  const downloadDir = testInfo.outputPath('downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  // 1) Login & download CSV from PFG
  await page.goto(pfgUrl, { waitUntil: 'domcontentloaded' });

  // Try common login selectors; adjust once we see the real PFG page.
  const userLocator = page.locator('input[type="email"], input[name*=user i], input[id*=user i], input[name*=login i], input[id*=login i], input[type="text"]');
  const passLocator = page.locator('input[type="password"]');

  await expect(userLocator.first()).toBeVisible();
  await userLocator.first().fill(username);
  await expect(passLocator.first()).toBeVisible();
  await passLocator.first().fill(password);

  // Submit
  const submit = page.locator('button[type="submit"], input[type="submit"]');
  if (await submit.count()) {
    await submit.first().click();
  } else {
    await page.keyboard.press('Enter');
  }

  // Wait for navigation after login attempt.
  await page.waitForLoadState('networkidle');

  // Per your workflow:
  // 1) Click "Lists" in the top bar
  // 2) Under "My lists", open the 3-dot menu on the "FALL 2025" list card
  // 3) Click the 3rd icon from the left (download/export)
  // 4) On the export page, click "Export" to download CSV

  const listsTopNav = page.getByRole('link', { name: 'Lists' }).or(page.getByRole('button', { name: 'Lists' }));
  await expect(listsTopNav.first()).toBeVisible({ timeout: 30_000 });
  await listsTopNav.first().click();
  await page.waitForLoadState('networkidle');

  // Open the FALL 2025 list
  const fallListLink = page.getByRole('link', { name: /FALL 2025/i }).or(page.locator('text=FALL 2025').first());
  await expect(fallListLink.first()).toBeVisible({ timeout: 30_000 });
  await fallListLink.first().click();
  await page.waitForLoadState('networkidle');

  // On the FALL 2025 page, open the 3-dot menu next to "Manage list"
  const manageListBtn = page.getByRole('button', { name: /manage list/i });
  await expect(manageListBtn).toBeVisible({ timeout: 30_000 });

  // The kebab is the icon-only button to the right of "Manage list" in the same header row.
  // This is the next button in DOM after "Manage list" on this page.
  const kebab = manageListBtn.locator('xpath=following::button[1]');
  await expect(kebab).toBeVisible({ timeout: 30_000 });
  await kebab.click();

  // Click "Export" in the dropdown menu
  const exportMenuItem = page.locator('[role="menu"] >> text=Export').first().or(page.locator('text=Export').first());
  await expect(exportMenuItem).toBeVisible({ timeout: 30_000 });
  await exportMenuItem.click();

  // On the export page, click Export to trigger CSV download
  await page.waitForLoadState('networkidle');
  const exportButton = page.getByRole('button', { name: /^export$/i }).or(page.getByRole('button', { name: /export/i })).first();
  await expect(exportButton).toBeVisible({ timeout: 30_000 });

  // Export can be flaky: sometimes first click does nothing.
  // We'll retry a few times and accept either:
  // - Playwright "download" event
  // - A response that looks like CSV / attachment
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
        url.includes('export')
      );
    } catch {
      return false;
    }
  };

  async function attemptExportOnce(timeoutMs) {
    const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
    const responsePromise = page
      .waitForEvent('response', csvLikeResponsePredicate, { timeout: timeoutMs })
      .catch(() => null);

    // Force click to avoid overlays/edge cases.
    await exportButton.click({ force: true });

    const never = () => new Promise(() => {});
    const downloadReady = downloadPromise.then((d) => (d ? { kind: 'download', download: d } : never()));
    const responseReady = responsePromise.then((r) => (r ? { kind: 'response', response: r } : never()));
    return /** @type {Promise<{kind:'download', download:any} | {kind:'response', response:any}>} */ (
      Promise.race([downloadReady, responseReady])
    );
  }

  let first = null;
  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    try {
      // Fast retries: 8s each. If it’s going to work, it typically starts quickly.
      // If not, we retry click.
      // eslint-disable-next-line no-await-in-loop
      first = await attemptExportOnce(8_000);
      break;
    } catch {
      // ignore and retry
    }
  }

  if (!first) {
    // Last-chance longer wait (in case the export is actually slow today)
    first = await attemptExportOnce(180_000);
  }

  let targetPath;

  if (first.kind === 'download') {
    const suggested = first.download.suggestedFilename();
    targetPath = path.join(downloadDir, suggested.endsWith('.csv') ? suggested : 'pfg-order-guide.csv');
    await first.download.saveAs(targetPath);
  } else {
    const body = await first.response.body();
    targetPath = path.join(downloadDir, 'pfg-order-guide.csv');
    fs.writeFileSync(targetPath, body);
  }

  // 2) Upload into localhost UI (biweekly tab -> PFG input)
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Biweekly Order Providers' }).click();
  await page.waitForSelector('#biweekly-order.tab-content.active', { timeout: 15_000 });

  // Upload into the PFG CSV input for the biweekly tab.
  const pfgInput = page.locator('#biweeklyPfgInput');
  // File inputs are intentionally hidden by CSS; Playwright can still set files on them.
  await pfgInput.setInputFiles(targetPath);

  // Confirm the UI picked up the file selection
  const pfgFileList = page.locator('#biweeklyPfgFileList');
  await expect(pfgFileList).toContainText('.csv', { timeout: 15_000 });

  // Keep the browser open if requested so you can visually confirm.
  if (process.env.PW_KEEP_OPEN === '1') {
    // If the page gets closed by site navigation or other behavior, keep the browser open anyway.
    // Waiting on the context is more resilient than waiting on a specific page.
    await context.waitForEvent('close', { timeout: 10 * 60 * 1000 }).catch(() => {});
  }
});

