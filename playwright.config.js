// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './playwright',
  timeout: 2 * 60 * 1000,
  expect: { timeout: 10_000 },
  use: {
    headless: false,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});

