const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
require('dotenv').config();

/**
 * US Foods (planner Step A): open login and verify fields.
 *
 * Env:
 * - US_FOODS_URL (optional; default: https://order.usfoods.com/desktop/home)
 * - US_FOODS_USERNAME
 * - US_FOODS_PASSWORD
 */
test('US Foods: download Fall 2025 list with product prices', async ({ page }, testInfo) => {
  test.setTimeout(2 * 60 * 1000);

  const url = (process.env.US_FOODS_URL || 'https://order.usfoods.com/desktop/home').trim();
  const username = process.env.US_FOODS_USERNAME;
  const password = process.env.US_FOODS_PASSWORD;

  expect(username, 'Set US_FOODS_USERNAME in .env').toBeTruthy();
  expect(password, 'Set US_FOODS_PASSWORD in .env').toBeTruthy();

  await page.setViewportSize({ width: 1920, height: 1080 });

  const outDir = testInfo.outputPath('downloads');
  fs.mkdirSync(outDir, { recursive: true });
  // eslint-disable-next-line no-unused-vars
  const savePath = path.join(outDir, 'usfoods-download.csv');

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Step A success: we can see the login entry point.
  // US Foods commonly starts with "User ID" only, then password is on the next screen.
  const userField = page
    .locator(
      'input[type="email"], input[type="text"][autocomplete="username"], input[name*="user" i], input[id*="user" i], input[placeholder*="email" i]'
    )
    .first();
  const loginBtn = page.getByRole('button', { name: /^log in$/i }).first();

  await expect(userField).toBeVisible({ timeout: 45_000 });
  await expect(loginBtn).toBeVisible({ timeout: 45_000 });

  // Stop here for Step A (Executor will implement full flow in next step after user verifies).
});

