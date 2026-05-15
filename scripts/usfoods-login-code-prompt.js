const { chromium, expect } = require('@playwright/test');
const readline = require('readline/promises');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

async function firstVisible(page, locators, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const locator of locators) {
      const target = locator.first();
      if (await target.isVisible().catch(() => false)) return target;
    }
    await page.waitForTimeout(350);
  }
  throw new Error('Expected control was not visible.');
}

async function maybeFirstVisible(page, locators, timeout = 8_000) {
  try {
    return await firstVisible(page, locators, timeout);
  } catch {
    return null;
  }
}

async function chooseEmailMfa(page, timeout = 45_000) {
  console.log('STEP choose email MFA option');
  const emailMfa = await firstVisible(page, [
    page.getByRole('button', { name: /email/i }),
    page.getByRole('link', { name: /email/i }),
    page.locator('button, a, label, div[role="button"]').filter({ hasText: /email/i }),
    page.locator('button, a, label, div[role="button"]').filter({ hasText: /send.*code/i }),
    page.locator('button, a, label, div[role="button"]').filter({ hasText: /one.?time/i })
  ], timeout);
  await emailMfa.click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const sendCode = await maybeFirstVisible(page, [
    page.getByRole('button', { name: /send/i }),
    page.getByRole('button', { name: /continue/i }),
    page.getByRole('button', { name: /next/i }),
    page.locator('button[type="submit"]')
  ], 8_000);
  if (sendCode) {
    await sendCode.click({ force: true });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
}

async function enterCodeFromStdin(page) {
  console.log('STEP wait for code field');
  const codeField = await firstVisible(page, [
    page.locator('input[autocomplete="one-time-code"]'),
    page.locator('input[name*="code" i]'),
    page.locator('input[id*="code" i]'),
    page.locator('input[placeholder*="code" i]'),
    page.locator('input[type="tel"]'),
    page.locator('input[type="text"]')
  ], 90_000);

  process.stdout.write('READY_FOR_US_FOODS_CODE\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('Code: ')).trim();
  rl.close();

  await codeField.fill(code);
  const verifyCode = await firstVisible(page, [
    page.getByRole('button', { name: /^verify$/i }),
    page.getByRole('button', { name: /^submit$/i }),
    page.getByRole('button', { name: /^continue$/i }),
    page.getByRole('button', { name: /^log in$/i }),
    page.locator('button[type="submit"]')
  ]);
  await verifyCode.click({ force: true, timeout: 10_000 }).catch(async () => {
    await verifyCode.evaluate((el) => el.click());
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function dumpVisibleControls(page, label) {
  const outDir = path.join(__dirname, '..', 'test-results', 'usfoods-debug');
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${label}.png`), fullPage: true }).catch(() => {});
  const controls = await page
    .locator('button, a, [role="button"], [aria-label], [title]')
    .evaluateAll((els) =>
      els.slice(0, 160).map((el) => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        role: el.getAttribute('role') || '',
        cls: el.getAttribute('class') || ''
      }))
    )
    .catch(() => []);
  fs.writeFileSync(path.join(outDir, `${label}-controls.json`), JSON.stringify(controls, null, 2));
  console.log(`DEBUG_DUMP=${path.join(outDir, label)}`);
}

async function acceptStaySignedInIfShown(page) {
  console.log('STEP accept stay signed in');
  const yesButton = await maybeFirstVisible(page, [
    page.getByRole('button', { name: /^yes$/i }),
    page.locator('button, input[type="submit"], a[role="button"]').filter({ hasText: /^yes$/i }),
    page.locator('button, input[type="submit"], a[role="button"]').filter({ hasText: /stay signed in/i })
  ], 20_000);
  if (!yesButton) return;
  await yesButton.click({ force: true }).catch(async () => {
    await yesButton.evaluate((el) => el.click());
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function clickMyLists(page) {
  console.log('STEP click My Lists');
  const myLists = await firstVisible(page, [
    page.getByRole('link', { name: /my\s+lists/i }),
    page.getByRole('button', { name: /my\s+lists/i }),
    page.locator('a, button, div[role="button"], [role="tab"]').filter({ hasText: /my\s+lists/i })
  ], 45_000);
  await myLists.click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);

  const lastViewed = page.getByText(/last viewed/i).first();
  if (!(await lastViewed.isVisible({ timeout: 3000 }).catch(() => false))) {
    const viewAllLists = await maybeFirstVisible(page, [
      page.getByRole('link', { name: /view all lists/i }),
      page.getByRole('button', { name: /view all lists/i }),
      page.locator('a, button, div[role="button"]').filter({ hasText: /view all lists/i })
    ], 10_000);
    if (viewAllLists) {
      console.log('STEP click View All Lists');
      await viewAllLists.click({ force: true });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
}

async function openFall2025Guide(page) {
  console.log('STEP open Fall 2025 guide');
  await dumpVisibleControls(page, 'my-lists-before-fall-click');

  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll('body *')].filter(visible);
    const lastViewed = all.find((el) => /^last viewed$/i.test(textOf(el)));
    const myShopping = all.find((el) => /^my shopping lists$/i.test(textOf(el)));
    const lastY = lastViewed ? lastViewed.getBoundingClientRect().bottom : 0;
    const shoppingY = myShopping ? myShopping.getBoundingClientRect().top : window.innerHeight;

    const textCandidates = all
      .filter((el) => /^fall\s*2025$/i.test(textOf(el)))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, rect, text: textOf(el) };
      })
      .filter(({ rect }) => rect.top > lastY && rect.top < shoppingY)
      .sort((a, b) => a.rect.top - b.rect.top);

    let match = textCandidates[0];
    if (!match) {
      const rows = [...document.querySelectorAll('a, button, [role="button"], tr, li, ion-item, div')]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, rect, area: rect.width * rect.height, text: textOf(el) };
        })
        .filter(({ rect, text }) => /fall\s*2025/i.test(text) && /\b108\b/.test(text) && /\b1\b/.test(text) && rect.width >= 300)
        .sort((a, b) => a.area - b.area);
      match = rows[0];
    }
    if (!match) return null;
    const rect = match.rect;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: match.text.slice(0, 160)
    };
  });

  if (!clicked) {
    await dumpVisibleControls(page, 'fall-2025-row-not-found');
    throw new Error('Could not find the Fall 2025 list row with 108 products and 1 discontinued.');
  }

  console.log(`STEP click matched Fall 2025 row: ${clicked.text}`);
  await page.mouse.click(clicked.x, clicked.y);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForURL(/\/desktop\/lists\/view\//i, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);

  if (!/\/desktop\/lists\/view\//i.test(page.url())) {
    await dumpVisibleControls(page, 'fall-2025-click-did-not-open-detail');
    throw new Error('Clicked Fall 2025, but US Foods did not navigate to the list detail page.');
  }
}

async function exportFallGuideWithPrices(page) {
  console.log('STEP open download icon');
  const printDownloadPoint = await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const matches = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
      .filter(({ rect, text }) => {
        if (!/download/i.test(text)) return false;
        if (/download options/i.test(text)) return false;
        return rect.top >= 120 && rect.top <= 190 && rect.left >= window.innerWidth * 0.68;
      })
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

    const match = matches[0];
    if (match) {
      return {
        x: match.rect.left + match.rect.width / 2,
        y: match.rect.top + match.rect.height / 2,
        text: match.text.slice(0, 80)
      };
    }

    // Stable fallback for the US Foods list detail toolbar: Download is next to Print,
    // below the global header, near the upper-right of a 1920px viewport.
    return { x: window.innerWidth * 0.795, y: 157, text: 'coordinate fallback near Print/Download toolbar' };
  });

  if (printDownloadPoint) {
    console.log(`STEP click Download near Print: ${printDownloadPoint.text}`);
    await page.mouse.click(printDownloadPoint.x, printDownloadPoint.y);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);
    await dumpVisibleControls(page, 'after-download-icon-click');
  } else {
    const downloadClickPoint = await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const haystack = [
          textOf(el),
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-cy') || '',
          el.getAttribute('class') || '',
          el.innerHTML || ''
        ].join(' ');
        return { el, rect, haystack };
      })
      .filter(({ rect, haystack }) => {
        if (rect.top < 100 || rect.top > 420) return false;
        if (rect.left < window.innerWidth * 0.45) return false;
        if (/youtube|facebook|instagram|footer/i.test(haystack)) return false;
        return /download|export|arrow_down|cloud_download|file_download|download-outline|download-sharp/i.test(haystack);
      })
      .sort((a, b) => a.rect.top - b.rect.top || b.rect.left - a.rect.left);

    const match = candidates[0];
    if (!match) return null;
    return {
      x: match.rect.left + match.rect.width / 2,
      y: match.rect.top + match.rect.height / 2,
      text: textOf(match.el).slice(0, 120),
      aria: match.el.getAttribute('aria-label') || '',
      title: match.el.getAttribute('title') || ''
    };
  });

    if (!downloadClickPoint) {
      await dumpVisibleControls(page, 'after-fall-guide-before-download');
      throw new Error('Could not find the top-right download icon on the Fall 2025 list page.');
    }

    console.log(`STEP click download icon candidate: ${downloadClickPoint.aria || downloadClickPoint.title || downloadClickPoint.text}`);
    await page.mouse.click(downloadClickPoint.x, downloadClickPoint.y);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);
    await dumpVisibleControls(page, 'after-download-icon-click');
  }

  console.log('STEP open download options');
  let downloadOptions;
  try {
    downloadOptions = await firstVisible(page, [
      page.getByText(/download options/i),
      page.getByRole('button', { name: /download options/i }),
      page.getByRole('link', { name: /download options/i }),
      page.locator('button, a, summary, ion-item, ion-label, div[role="button"], [class*="accordion" i]').filter({ hasText: /download options/i }),
      page.locator('text=/download\\s+options/i')
    ], 30_000);
  } catch (error) {
    await dumpVisibleControls(page, 'download-popup-missing-options');
    throw error;
  }
  await downloadOptions.click({ force: true });
  await page.waitForTimeout(500);

  console.log('STEP select product prices');
  const productPrices = await firstVisible(page, [
    page.getByLabel(/product prices/i),
    page.getByRole('checkbox', { name: /product prices/i }),
    page.locator('label').filter({ hasText: /product prices/i }),
    page.locator('input[type="checkbox"][name*="price" i], input[type="checkbox"][id*="price" i]')
  ], 30_000);
  const tagName = await productPrices.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tagName === 'input') {
    await productPrices.check({ force: true }).catch(async () => productPrices.click({ force: true }));
  } else {
    await productPrices.click({ force: true });
  }

  console.log('STEP click green Download');
  const exportButton = await firstVisible(page, [
    page.getByRole('button', { name: /^download$/i }),
    page.getByRole('button', { name: /download/i }),
    page.locator('button, a[role="button"]').filter({ hasText: /download/i })
  ], 30_000);

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    exportButton.click({ force: true })
  ]).then(([d]) => d);

  const downloadDir = path.join(__dirname, '..', 'test-results', 'usfoods-manual-downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  const suggested = download.suggestedFilename() || 'usfoods-fall-2025.csv';
  const target = path.join(downloadDir, /\.csv$/i.test(suggested) ? suggested : 'usfoods-fall-2025.csv');
  await download.saveAs(target);
  process.stdout.write(`US_FOODS_CSV=${target}\n`);
}

async function main() {
  const url = (process.env.US_FOODS_URL || 'https://order.usfoods.com/desktop/home').trim();
  const username = process.env.US_FOODS_USERNAME;
  const password = process.env.US_FOODS_PASSWORD;

  expect(username, 'Set US_FOODS_USERNAME').toBeTruthy();
  expect(password, 'Set US_FOODS_PASSWORD').toBeTruthy();

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  console.log('STEP goto');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('STEP click login entry');
  const loginEntry = await firstVisible(page, [
    page.getByRole('button', { name: /^log in$/i }),
    page.getByRole('link', { name: /^log in$/i })
  ]);
  await loginEntry.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  console.log('STEP fill username');
  const userField = await firstVisible(page, [
    page.locator('input[type="email"]'),
    page.locator('input[type="text"][autocomplete="username"]'),
    page.locator('input[name*="user" i]'),
    page.locator('input[id*="user" i]'),
    page.locator('input[placeholder*="email" i]'),
    page.locator('input[placeholder*="user" i]')
  ]);
  await userField.fill(username);

  console.log('STEP submit username');
  const userNext = await firstVisible(page, [
    page.getByRole('button', { name: /^next$/i }),
    page.getByRole('button', { name: /^continue$/i }),
    page.getByRole('button', { name: /^log in$/i }),
    page.locator('button[type="submit"]')
  ]);
  await userNext.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  await chooseEmailMfa(page);
  await enterCodeFromStdin(page);
  await acceptStaySignedInIfShown(page);

  const passField = await maybeFirstVisible(page, [page.locator('input[type="password"]')], 20_000);
  if (passField) {
    console.log('STEP fill password');
    await passField.fill(password);

    console.log('STEP submit password');
    const passNext = await firstVisible(page, [
      page.getByRole('button', { name: /^sign in$/i }),
      page.getByRole('button', { name: /^log in$/i }),
      page.getByRole('button', { name: /^verify$/i }),
      page.getByRole('button', { name: /^continue$/i }),
      page.locator('button[type="submit"]')
    ]);
    await passNext.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  const current = new URL(page.url());
  process.stdout.write(`US_FOODS_LOGIN_AT=${current.origin}${current.pathname}\n`);

  await clickMyLists(page);
  await openFall2025Guide(page);
  await exportFallGuideWithPrices(page);

  await browser.close();
}

main().catch(async (error) => {
  console.error(error.message);
  process.exit(1);
});
