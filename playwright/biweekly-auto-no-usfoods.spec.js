const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const { assertMappingTermsInDownloadedCsvs, fileDoesNotLookLikeCsv } = require('./lib/mapping-csv-term-verify');
const envCandidates = [
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env')
].filter((envPath) => fs.existsSync(envPath));
require('dotenv').config({ path: envCandidates.length > 0 ? envCandidates : path.join(__dirname, '..', '.env') });

/**
 * Biweekly Auto:
 * - Downloads PFG + Sysco + GFS + US Foods provider CSVs in one Playwright run
 * - Opens localhost and uploads them into the 4-vendor biweekly analyzer
 * - Clicks "Generate Order Plan" and waits for recommendations
 *
 * Preconditions:
 * - `npm start` is already running (http://localhost:3000)
 * - `.env` has vendor creds
 * - US Foods email MFA is auto-read from Gmail when IMAP/app-password creds work,
 *   otherwise write the six-digit code to test-results/usfoods-mfa-code.txt when prompted
 */
test('Biweekly Auto: download provider CSVs and generate order plan', async ({ browser }, testInfo) => {
  // Full end-to-end vendor run can exceed 15 minutes (vendor sites + MFA + downloads + localhost processing).
  test.setTimeout(20 * 60 * 1000);

  // Fresh state each run: new context means no cookies/localStorage from any prior run.
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 }
  });

  const downloadDir = testInfo.outputPath('downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function firstVisible(page, locators, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const locator of locators) {
        const target = locator.first();
        // eslint-disable-next-line no-await-in-loop
        if (await target.isVisible().catch(() => false)) return target;
      }
      // eslint-disable-next-line no-await-in-loop
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

  let usFoodsGmailWarningPrinted = false;

  function fetchUsFoodsCodeFromGmail(startedAtMs) {
    const gmailAddress = process.env.US_FOODS_MFA_EMAIL || process.env.FOOD_GMAIL_ADDRESS;
    const gmailPassword = process.env.US_FOODS_MFA_GMAIL_PASSWORD || process.env.FOOD_GMAIL_APP_PASSWORD;
    if (!gmailAddress || !gmailPassword) return null;

    const script = String.raw`
import imaplib, email, re, sys, time
from email.utils import parsedate_to_datetime
addr, password, started = sys.argv[1], sys.argv[2], int(sys.argv[3]) / 1000
queries = [
    ('INBOX', '(OR FROM "usfoods" SUBJECT "passcode")'),
    ('INBOX', '(OR SUBJECT "one-time" SUBJECT "verification")'),
    ('INBOX', 'ALL'),
]

def msg_text(msg):
    parts = [msg.get('Subject', ''), msg.get('From', ''), msg.get('Date', '')]
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() in ('text/plain', 'text/html'):
                payload = part.get_payload(decode=True)
                if payload:
                    parts.append(payload.decode(part.get_content_charset() or 'utf-8', 'ignore'))
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            parts.append(payload.decode(msg.get_content_charset() or 'utf-8', 'ignore'))
    return '\n'.join(parts)

try:
    mail = imaplib.IMAP4_SSL('imap.gmail.com')
    mail.login(addr, password)
    candidates = []
    for folder, query in queries:
        typ, _ = mail.select(folder, readonly=True)
        if typ != 'OK':
            continue
        typ, data = mail.search(None, query)
        if typ != 'OK' or not data or not data[0]:
            continue
        for mid in data[0].split()[-25:]:
            typ, msgdata = mail.fetch(mid, '(RFC822)')
            if typ != 'OK' or not msgdata or not msgdata[0]:
                continue
            msg = email.message_from_bytes(msgdata[0][1])
            try:
                ts = parsedate_to_datetime(msg.get('Date')).timestamp()
            except Exception:
                ts = time.time()
            if ts < started - 180:
                continue
            text = msg_text(msg)
            if not re.search(r'US\s*Foods|USFoods|one[-\s]?time|passcode|verification\s+code', text, re.I):
                continue
            m = re.search(r'(?<!\d)(\d{6})(?!\d)', text)
            if m:
                candidates.append((ts, m.group(1)))
    mail.logout()
    if candidates:
        candidates.sort(reverse=True)
        print(candidates[0][1])
except Exception as e:
    # Keep Playwright output clean and avoid leaking account details.
    msg = str(e)
    if 'Application-specific password required' in msg:
        print('__ERROR__:APP_PASSWORD_REQUIRED')
    elif 'AUTHENTICATIONFAILED' in msg or 'Invalid credentials' in msg:
        print('__ERROR__:AUTH_FAILED')
    else:
        print('__ERROR__:GMAIL_FETCH_FAILED')
`;

    const result = spawnSync('python3', ['-c', script, gmailAddress, gmailPassword, String(startedAtMs)], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const output = (result.stdout || '').trim();
    if (/^\d{6}$/.test(output)) return output;
    if (output.startsWith('__ERROR__:') && !usFoodsGmailWarningPrinted) {
      usFoodsGmailWarningPrinted = true;
      const reason = output.replace('__ERROR__:', '');
      process.stderr.write(`[usfoods-mfa] Gmail IMAP auto-fetch unavailable (${reason}); still watching code file fallback.\n`);
    }
    return null;
  }

  async function promptForUsFoodsCode() {
    const codeFile = path.join(__dirname, '..', 'test-results', 'usfoods-mfa-code.txt');
    fs.mkdirSync(path.dirname(codeFile), { recursive: true });
    fs.rmSync(codeFile, { force: true });

    const started = Date.now();
    const canUseGmail = Boolean(process.env.US_FOODS_MFA_EMAIL || process.env.FOOD_GMAIL_ADDRESS) && Boolean(process.env.US_FOODS_MFA_GMAIL_PASSWORD || process.env.FOOD_GMAIL_APP_PASSWORD);
    if (canUseGmail) {
      process.stdout.write('WAITING_FOR_US_FOODS_EMAIL_CODE\n');
      process.stdout.write(`READY_FOR_US_FOODS_CODE_FILE=${codeFile}\n`);
    } else {
      process.stdout.write(`READY_FOR_US_FOODS_CODE_FILE=${codeFile}\n`);
    }

    while (Date.now() - started < 5 * 60 * 1000) {
      const gmailCode = fetchUsFoodsCodeFromGmail(started);
      if (gmailCode) {
        process.stdout.write('US_FOODS_EMAIL_CODE_FOUND\n');
        return gmailCode;
      }

      if (fs.existsSync(codeFile)) {
        const code = fs.readFileSync(codeFile, 'utf8').trim();
        fs.rmSync(codeFile, { force: true });
        if (/^\d{6}$/.test(code)) return code;
        throw new Error(`US Foods MFA code file must contain exactly 6 digits: ${codeFile}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await pause(5000);
    }

    throw new Error(`Timed out waiting for US Foods MFA code from Gmail or file: ${codeFile}`);
  }

  async function chooseUsFoodsEmailMfa(page, timeout = 45_000) {
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

  async function enterUsFoodsCode(page) {
    console.log('STEP wait for code field');
    await firstVisible(page, [
      page.locator('input[autocomplete="one-time-code"]'),
      page.locator('input[name*="code" i]'),
      page.locator('input[id*="code" i]'),
      page.locator('input[placeholder*="code" i]'),
      page.locator('input[type="tel"]'),
      page.locator(
        'input[type="text"]:not([type="search"]):not([placeholder*="search" i]):not([aria-label*="search" i]):not([name*="search" i]):not([id*="search" i])'
      )
    ], 90_000);

    const code = await promptForUsFoodsCode();
    const debugDir = path.join(__dirname, '..', 'test-results', 'usfoods-debug');
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, 'mfa-before-entry.png'), fullPage: true }).catch(() => {});

    const mfaDialog = page
      .locator('[role="dialog"], [role="alertdialog"], .modal')
      .filter({ hasText: /one-time passcode|verification code|passcode/i })
      .last();

    async function resolveMfaInputs() {
      // Prefer inputs inside the visible passcode modal. If the dialog is not exposed with
      // a role/class, fall back to visible one-time-code/code inputs on the page.
      const scoped = mfaDialog.locator('input:not([type="hidden"])');
      const scopedCount = await scoped.count().catch(() => 0);
      const scopedVisible = [];
      for (let i = 0; i < scopedCount; i++) {
        const input = scoped.nth(i);
        // eslint-disable-next-line no-await-in-loop
        if (await input.isVisible().catch(() => false)) scopedVisible.push(i);
      }
      if (scopedVisible.length > 0) return { locator: scoped, visibleIndexes: scopedVisible, source: 'modal' };

      const fallback = page.locator(
        [
          'input[autocomplete="one-time-code"]',
          'input[name*="code" i]',
          'input[id*="code" i]',
          'input[placeholder*="code" i]',
          'input[type="tel"]',
          'input[inputmode="numeric"]',
          'input[type="text"]:not([type="search"]):not([placeholder*="search" i]):not([aria-label*="search" i]):not([name*="search" i]):not([id*="search" i])'
        ].join(', ')
      );
      const fallbackCount = await fallback.count().catch(() => 0);
      const fallbackVisible = [];
      for (let i = 0; i < fallbackCount; i++) {
        const input = fallback.nth(i);
        // eslint-disable-next-line no-await-in-loop
        if (await input.isVisible().catch(() => false)) fallbackVisible.push(i);
      }
      return { locator: fallback, visibleIndexes: fallbackVisible, source: 'page' };
    }

    let mfaInputState = await resolveMfaInputs();
    let mfaInputs = mfaInputState.locator;
    let visibleInputIndexes = mfaInputState.visibleIndexes;

    console.log(`US Foods MFA visible input count: ${visibleInputIndexes.length} (${mfaInputState.source})`);
    const inputMeta = await mfaInputs.evaluateAll((els) =>
      els.map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          visible: (() => {
            const style = window.getComputedStyle(el);
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          })(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.getAttribute('id') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          placeholder: el.getAttribute('placeholder') || '',
          inputmode: el.getAttribute('inputmode') || '',
          maxlength: el.getAttribute('maxlength') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          valueLength: (el.value || '').length
        };
      })
    ).catch(() => []);
    console.log(`US Foods MFA input metadata: ${JSON.stringify(inputMeta)}`);

    async function fillKnownUsFoodsCodeBoxes(codeValue) {
      const digits = codeValue.split('');
      for (let i = 0; i < digits.length; i++) {
        const box = page.locator(`#code${i + 1}`);
        // eslint-disable-next-line no-await-in-loop
        if (await box.isVisible({ timeout: 1500 }).catch(() => false)) {
          // eslint-disable-next-line no-await-in-loop
          await box.fill(digits[i], { force: true }).catch(async () => {
            await box.click({ force: true });
            await page.keyboard.type(digits[i]);
          });
        }
      }
    }

    async function setUsFoodsCodeByDom(codeValue) {
      const digits = codeValue.split('');
      const codeIdsVisible = await page.locator('#code1, #code2, #code3, #code4, #code5, #code6').first().isVisible({ timeout: 1500 }).catch(() => false);
      if (codeIdsVisible) {
        await page.evaluate((digitsLocal) => {
          const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          const setNativeValue = proto && proto.set ? proto.set : null;
          digitsLocal.forEach((digit, index) => {
            const el = document.querySelector(`#code${index + 1}`);
            if (!el) return;
            el.focus();
            if (setNativeValue) {
              setNativeValue.call(el, digit);
            } else {
              el.value = digit;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: digit }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }, digits);
        return;
      }

      await mfaInputs.evaluateAll((els, payload) => {
        const digitsLocal = payload.digits;
        const visibleIndexesLocal = payload.visibleIndexes;
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const setNativeValue = proto && proto.set ? proto.set : null;
        const makeInputEvent = (value) =>
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: value
          });
        const makeChangeEvent = () => new Event('change', { bubbles: true });
        visibleIndexesLocal.forEach((visibleIndex, digitIndex) => {
          const el = els[visibleIndex];
          const digit = digitsLocal[digitIndex] || '';
          if (!el) return;
          el.focus();
          if (setNativeValue) {
            setNativeValue.call(el, digit);
          } else {
            // eslint-disable-next-line no-param-reassign
            el.value = digit;
          }
          el.dispatchEvent(makeInputEvent(digit));
          el.dispatchEvent(makeChangeEvent());
        });
      }, { digits, visibleIndexes: visibleInputIndexes });
    }

    async function setUsFoodsCodeByKeyboard(codeValue) {
      mfaInputState = await resolveMfaInputs();
      mfaInputs = mfaInputState.locator;
      visibleInputIndexes = mfaInputState.visibleIndexes;
      if (visibleInputIndexes.length === 0) throw new Error('US Foods MFA passcode inputs are not visible.');

      // The US Foods passcode control is six separate boxes. It is most reliable when
      // driven like a real user: focus the first box and type all six digits, letting
      // the site's key/input handlers advance focus and auto-submit. Programmatic
      // .fill() on each box can populate DOM values without updating app state.
      for (const index of visibleInputIndexes) {
        const input = mfaInputs.nth(index);
        // eslint-disable-next-line no-await-in-loop
        await input.fill('', { force: true }).catch(() => {});
      }
      const target = mfaInputs.nth(visibleInputIndexes[0]);
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ force: true });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(codeValue, { delay: 85 });
    }

    async function readUsFoodsCodeValues() {
      mfaInputState = await resolveMfaInputs();
      mfaInputs = mfaInputState.locator;
      visibleInputIndexes = mfaInputState.visibleIndexes;
      const mfaValueLengths = [];
      for (const index of visibleInputIndexes) {
        // eslint-disable-next-line no-await-in-loop
        const value = await mfaInputs.nth(index).inputValue().catch(() => '');
        mfaValueLengths.push(value.length);
      }
      return mfaValueLengths;
    }

    async function codeModalStillVisible() {
      return mfaDialog.isVisible({ timeout: 1500 }).catch(() => false);
    }

    async function postCodeStepReached() {
      return (
        (await page.getByRole('button', { name: /^yes$/i }).first().isVisible({ timeout: 1200 }).catch(() => false)) ||
        (await page.locator('input[type="submit"][value="Yes"], input[type="button"][value="Yes"]').first().isVisible({ timeout: 1200 }).catch(() => false)) ||
        (await page.getByRole('link', { name: /my\s+lists/i }).first().isVisible({ timeout: 1200 }).catch(() => false)) ||
        (await page.getByRole('button', { name: /my\s+lists/i }).first().isVisible({ timeout: 1200 }).catch(() => false)) ||
        !(await codeModalStillVisible())
      );
    }

    await setUsFoodsCodeByKeyboard(code);
    await page.waitForTimeout(1800);
    let mfaValueLengths = await readUsFoodsCodeValues();
    console.log(`US Foods MFA value lengths after keyboard entry: ${JSON.stringify(mfaValueLengths)}`);

    if (!(await postCodeStepReached()) && visibleInputIndexes.length >= 2 && mfaValueLengths.reduce((sum, length) => sum + length, 0) < code.length) {
      await fillKnownUsFoodsCodeBoxes(code);
      await page.waitForTimeout(600);
      mfaValueLengths = await readUsFoodsCodeValues();
      console.log(`US Foods MFA value lengths after direct box fill fallback: ${JSON.stringify(mfaValueLengths)}`);
    }

    if (!(await postCodeStepReached()) && visibleInputIndexes.length >= 2 && mfaValueLengths.reduce((sum, length) => sum + length, 0) < code.length) {
      await setUsFoodsCodeByDom(code).catch(() => {});
      await page.waitForTimeout(600);
      mfaValueLengths = await readUsFoodsCodeValues();
      console.log(`US Foods MFA value lengths after DOM fallback: ${JSON.stringify(mfaValueLengths)}`);
    }

    if (!(await postCodeStepReached()) && visibleInputIndexes.length < 2) {
      const codeField = await firstVisible(page, [
        page.locator('input[autocomplete="one-time-code"]'),
        page.locator('input[name*="code" i]'),
        page.locator('input[id*="code" i]'),
        page.locator('input[placeholder*="code" i]'),
        page.locator('input[type="tel"]'),
        page.locator(
          'input[type="text"]:not([type="search"]):not([placeholder*="search" i]):not([aria-label*="search" i]):not([name*="search" i]):not([id*="search" i])'
        )
      ], 10_000);
      await codeField.scrollIntoViewIfNeeded().catch(() => {});
      await codeField.click({ force: true });
      await codeField.fill(code);
    }

    await page.waitForTimeout(500);
    mfaValueLengths = await readUsFoodsCodeValues();
    console.log(`US Foods MFA value lengths after entry: ${JSON.stringify(mfaValueLengths)}`);
    await page.screenshot({ path: path.join(debugDir, 'mfa-after-entry.png'), fullPage: true }).catch(() => {});

    if (await postCodeStepReached()) return;

    const modalStillVisible = await codeModalStillVisible();
    if (visibleInputIndexes.length >= 2 && modalStillVisible && mfaValueLengths.reduce((sum, length) => sum + length, 0) < code.length) {
      throw new Error('US Foods MFA code entry did not populate all passcode boxes.');
    }

    // Some versions auto-submit after the sixth digit; others need Enter or a button
    // that appears only after all boxes are filled.
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1200);
    if (await postCodeStepReached()) return;

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

  async function acceptUsFoodsStaySignedIn(page) {
    console.log('US Foods: accept stay signed in if shown');
    const yesButton = await maybeFirstVisible(page, [
      page.getByRole('button', { name: /^yes$/i }),
      page.locator('input[type="submit"][value="Yes"], input[type="button"][value="Yes"]'),
      page.locator('input[type="submit"], input[type="button"]').filter({ hasText: /^yes$/i }),
      page.locator('button, input[type="submit"], a[role="button"]').filter({ hasText: /^yes$/i }),
      page.locator('button, input[type="submit"], input[type="button"], a[role="button"]').filter({ hasText: /stay signed in/i })
    ], 20_000);
    if (!yesButton) {
      await dumpUsFoodsDebug(page, 'stay-signed-in-not-shown');
      return;
    }
    await yesButton.click({ force: true }).catch(async () => {
      await yesButton.evaluate((el) => el.click());
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }

  async function submitUsFoodsPasswordIfShown(page) {
    const passField = await maybeFirstVisible(page, [page.locator('input[type="password"]')], 20_000);
    if (!passField) return;

    console.log('US Foods: submit password after MFA');
    const password = process.env.US_FOODS_PASSWORD;
    expect(password, 'Set US_FOODS_PASSWORD in .env when US Foods asks for password after MFA').toBeTruthy();
    await passField.fill(password);

    const passNext = await firstVisible(page, [
      page.getByRole('button', { name: /^sign in$/i }),
      page.getByRole('button', { name: /^log in$/i }),
      page.getByRole('button', { name: /^verify$/i }),
      page.getByRole('button', { name: /^continue$/i }),
      page.locator('button[type="submit"]')
    ], 45_000);
    await passNext.click({ force: true }).catch(async () => {
      await passNext.evaluate((el) => el.click());
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }

  async function dumpUsFoodsDebug(page, label) {
    const debugDir = path.join(__dirname, '..', 'test-results', 'usfoods-debug');
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, `${label}.png`), fullPage: true }).catch(() => {});
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
    fs.writeFileSync(path.join(debugDir, `${label}-controls.json`), JSON.stringify(controls, null, 2));
    console.log(`US Foods debug dump: ${label}`);
  }

  async function clickMyLists(page) {
    console.log('US Foods: click My Lists');
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
        console.log('US Foods: click View All Lists');
        await viewAllLists.click({ force: true });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
  }

  async function openFall2025Guide(page) {
    console.log('US Foods: open Fall 2025 guide');
    await dumpUsFoodsDebug(page, 'my-lists-before-fall-click');

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
      await dumpUsFoodsDebug(page, 'fall-2025-row-not-found');
      throw new Error('Could not find the Fall 2025 list row with 108 products and 1 discontinued.');
    }

    console.log(`US Foods: click matched Fall 2025 row: ${clicked.text}`);
    await page.mouse.click(clicked.x, clicked.y);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForURL(/\/desktop\/lists\/view\//i, { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    if (!/\/desktop\/lists\/view\//i.test(page.url())) {
      await dumpUsFoodsDebug(page, 'fall-2025-click-did-not-open-detail');
      throw new Error('Clicked Fall 2025, but US Foods did not navigate to the list detail page.');
    }
  }

  async function exportFallGuideWithPrices(page) {
    console.log('US Foods: open download menu');
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
      return { x: window.innerWidth * 0.795, y: 157, text: 'coordinate fallback near Print/Download toolbar' };
    });

    console.log(`US Foods: click download toolbar target: ${printDownloadPoint.text}`);
    await page.mouse.click(printDownloadPoint.x, printDownloadPoint.y);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);
    await dumpUsFoodsDebug(page, 'after-download-icon-click');

    console.log('US Foods: open download options');
    const downloadOptions = await firstVisible(page, [
      page.getByText(/download options/i),
      page.getByRole('button', { name: /download options/i }),
      page.getByRole('link', { name: /download options/i }),
      page.locator('button, a, summary, ion-item, ion-label, div[role="button"], [class*="accordion" i]').filter({ hasText: /download options/i }),
      page.locator('text=/download\\s+options/i')
    ], 30_000);
    await downloadOptions.click({ force: true });
    await page.waitForTimeout(500);

    console.log('US Foods: select product prices');
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

    console.log('US Foods: click green Download');
    const greenDownload = await firstVisible(page, [
      page.getByRole('button', { name: /^download$/i }),
      page.getByRole('button', { name: /download/i }),
      page.locator('button, a[role="button"]').filter({ hasText: /download/i })
    ], 30_000);
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 180_000 }),
      greenDownload.click({ force: true })
    ]).then(([d]) => d);

    const suggested = download.suggestedFilename() || '';
    const out = path.join(downloadDir, /\.csv$/i.test(suggested) ? suggested : 'usfoods-fall-2025.csv');
    await download.saveAs(out);
    validateSavedCsvFile(out);
    return out;
  }

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
    const exportUiVisible = async () => {
      const pricing = page.getByRole('switch', { name: /include pricing/i });
      if (await pricing.isVisible({ timeout: 800 }).catch(() => false)) return true;
      const pricingText = page.getByText(/include pricing information|include pricing/i).first();
      if (await pricingText.isVisible({ timeout: 800 }).catch(() => false)) return true;
      const modal = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ hasText: /export|pricing|include/i })
        .last();
      if (await modal.isVisible({ timeout: 800 }).catch(() => false)) return true;
      const exportBtn = page.getByRole('button', { name: /^export$/i });
      if (await exportBtn.isVisible({ timeout: 800 }).catch(() => false)) return true;
      return false;
    };

    async function clickVisibleSyscoExportList() {
      for (const ctx of allContexts()) {
        const exportItem = ctx
          .getByRole('menuitem', { name: /export\s*list/i })
          .or(ctx.locator('li[data-id="export-list-btn"]'))
          .or(ctx.locator('button, a, li, div[role="menuitem"], [role="option"]').filter({ hasText: /export\s*list/i }))
          .or(ctx.getByText(/^\s*export\s*list\s*$/i))
          .first();

        // eslint-disable-next-line no-await-in-loop
        if (!(await exportItem.isVisible({ timeout: 1500 }).catch(() => false))) continue;
        lastExportItem = exportItem;

        // eslint-disable-next-line no-await-in-loop
        const clicked =
          (await exportItem.click({ force: true, timeout: 3500 }).then(() => true).catch(() => false)) ||
          (await exportItem.evaluate((el) => el.click()).then(() => true).catch(() => false));
        if (!clicked) {
          // eslint-disable-next-line no-await-in-loop
          const box = await exportItem.boundingBox().catch(() => null);
          if (box) {
            // eslint-disable-next-line no-await-in-loop
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await pause(900);
        // eslint-disable-next-line no-await-in-loop
        if (await exportUiVisible()) return true;
      }

      const point = await page.evaluate(() => {
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
        const match = [...document.querySelectorAll('body *')]
          .filter(visible)
          .map((el) => ({ rect: el.getBoundingClientRect(), text: textOf(el) }))
          .filter(({ text }) => /^export\s*list$/i.test(text))
          .sort((a, b) => a.rect.top - b.rect.top)[0];
        if (!match) return null;
        return { x: match.rect.left + match.rect.width / 2, y: match.rect.top + match.rect.height / 2 };
      });
      if (!point) return false;
      await page.mouse.click(point.x, point.y);
      await pause(900);
      return exportUiVisible();
    }

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
        for (let clickAttempt = 0; clickAttempt < 5; clickAttempt++) {
          // eslint-disable-next-line no-await-in-loop
          if (await clickVisibleSyscoExportList()) {
            opened = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await pause(500);
        }
        if (opened) break;
      }
      if (opened) break;
      // eslint-disable-next-line no-await-in-loop
      await pause(400);
    }

    // Include pricing information. Sysco's control is a slider that is not always exposed
    // as a normal checkbox/switch, so click by label/nearby coordinates when needed.
    const pricingEnabled = await page.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const label = [...document.querySelectorAll('body *')]
        .filter(visible)
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: textOf(el) }))
        .filter(({ text }) => /include pricing information|include pricing/i.test(text))
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.el;
      if (!label) return { found: false, clicked: false };

      const container =
        label.closest('[role="dialog"], [role="alertdialog"], form, section') || label.parentElement || label;
      const explicit = container.querySelector(
        'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], button[aria-pressed], .switch, .toggle, .slider'
      );
      const target = explicit;
      const before =
        target
          ? target.getAttribute('aria-checked') ||
            target.getAttribute('aria-pressed') ||
            (target.checked === true ? 'true' : target.checked === false ? 'false' : '')
          : '';

      if (target && before !== 'true') {
        target.click();
      }

      const rect = label.getBoundingClientRect();
      return {
        found: true,
        clicked: !!target && before !== 'true',
        hasExplicit: !!target,
        labelX: rect.left + rect.width / 2,
        labelY: rect.top + rect.height / 2,
        sliderX: Math.min(window.innerWidth - 20, rect.right + 44),
        sliderY: rect.top + rect.height / 2
      };
    });

    if (!pricingEnabled.found) {
      const pricingSwitch = page.getByRole('switch', { name: /include pricing/i });
      if (await pricingSwitch.isVisible({ timeout: 10_000 }).catch(() => false)) {
        const checked = await pricingSwitch.getAttribute('aria-checked');
        if (checked !== 'true') await pricingSwitch.click({ force: true });
      } else {
        const pricingLabel = page.locator('label').filter({ hasText: /include pricing/i }).first();
        await expect(pricingLabel, 'Sysco include pricing information control should be visible').toBeVisible({ timeout: 10_000 });
        await pricingLabel.click({ force: true });
      }
    } else if (!pricingEnabled.hasExplicit) {
      // Sysco often renders this as a visual slider without checkbox semantics.
      // Click just to the right of the "Include pricing information" label.
      await page.mouse.click(pricingEnabled.sliderX, pricingEnabled.sliderY).catch(() => {});
    }
    await pause(600);

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

    let clickTarget = blueExport;

    if (!clickTarget) {
      for (const ctx of allContexts()) {
        const candidate = ctx
          .getByRole('button', { name: /^export$/i })
          .or(ctx.getByRole('button', { name: /export\s*list/i }))
          .or(ctx.locator('button').filter({ hasText: /^\s*export\s*$/i }))
          .first();
        // eslint-disable-next-line no-await-in-loop
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          clickTarget = candidate;
          break;
        }
      }
    }

    if (!clickTarget) clickTarget = lastExportItem;

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

  async function downloadUsFoodsCsv() {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const url = (process.env.US_FOODS_URL || 'https://order.usfoods.com/desktop/home').trim();
    const username = process.env.US_FOODS_USERNAME;
    expect(username, 'Set US_FOODS_USERNAME in .env').toBeTruthy();

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const loginEntry = await firstVisible(page, [
      page.getByRole('button', { name: /^log in$/i }),
      page.getByRole('link', { name: /^log in$/i })
    ], 45_000);
    await loginEntry.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const userField = await firstVisible(page, [
      page.locator('input[type="email"]'),
      page.locator('input[type="text"][autocomplete="username"]'),
      page.locator('input[name*="user" i]'),
      page.locator('input[id*="user" i]'),
      page.locator('input[placeholder*="email" i]'),
      page.locator('input[placeholder*="user" i]')
    ], 45_000);
    await userField.fill(username);

    const userNext = await firstVisible(page, [
      page.getByRole('button', { name: /^next$/i }),
      page.getByRole('button', { name: /^continue$/i }),
      page.getByRole('button', { name: /^log in$/i }),
      page.locator('button[type="submit"]')
    ], 45_000);
    await userNext.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    await chooseUsFoodsEmailMfa(page);
    await enterUsFoodsCode(page);
    await acceptUsFoodsStaySignedIn(page);
    await submitUsFoodsPasswordIfShown(page);
    await acceptUsFoodsStaySignedIn(page);

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
    await clickMyLists(page);
    await openFall2025Guide(page);
    const out = await exportFallGuideWithPrices(page);
    await page.close().catch(() => {});
    return out;
  }

  if ((process.env.US_FOODS_ONLY || '').trim() === '1') {
    const usFoodsPath = await test.step('Download US Foods CSV', async () => await downloadUsFoodsCsv());
    // eslint-disable-next-line no-console
    console.log(`US_FOODS_CSV=${usFoodsPath}`);
    await context.close().catch(() => {});
    return;
  }

  const pfgPath = await test.step('Download PFG CSV', async () => await downloadPfgCsv());
  const syscoPath = await test.step('Download Sysco CSV', async () => await downloadSyscoCsv());
  const gfsPath = await test.step('Download GFS CSV', async () => await downloadGfsCsv());
  const usFoodsPath = await test.step('Download US Foods CSV', async () => await downloadUsFoodsCsv());

  await test.step('Sanity check: saved downloads are real CSVs', async () => {
    const rawUsFoods = fs.readFileSync(usFoodsPath, 'utf8').slice(0, 12000);
    expect(fileDoesNotLookLikeCsv(rawUsFoods), `US Foods download did not look like CSV. First bytes: ${rawUsFoods.slice(0, 180)}`).toBe(false);
    const rawGfs = fs.readFileSync(gfsPath, 'utf8').slice(0, 12000);
    expect(fileDoesNotLookLikeCsv(rawGfs), `GFS download did not look like CSV. First bytes: ${rawGfs.slice(0, 180)}`).toBe(
      false
    );
  });

  // Playwright puts each run under test-results/.../ — print full paths so you can copy into .env for `npm run pw:verify-mapping`
  const downloadEnvBlock = `US_FOODS_CSV=${usFoodsPath}\nPFG_CSV=${pfgPath}\nSYSCO_CSV=${syscoPath}\nGFS_CSV=${gfsPath}`;
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

  await test.step('Upload all 4 CSVs to localhost and generate plan', async () => {
    const inventoryPath = path.join(__dirname, '..', 'tmp-biweekly-test', 'inventory.csv');
    const mappingPath = path.join(__dirname, '..', 'tmp-biweekly-test', 'mapping.xlsx');
    expect(fs.existsSync(inventoryPath), `Missing local inventory fixture: ${inventoryPath}`).toBe(true);
    expect(fs.existsSync(mappingPath), `Missing local mapping fixture: ${mappingPath}`).toBe(true);

    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /^biweekly order providers$/i }).click();
    await page.waitForSelector('#biweekly-order.tab-content.active', { timeout: 15_000 });

    await page.locator('#biweeklyInventoryInput').setInputFiles(inventoryPath);
    await page.locator('#biweeklyMappingInput').setInputFiles(mappingPath);
    await page.locator('#biweeklyUsFoodsInput').setInputFiles(usFoodsPath);
    await page.locator('#biweeklyPfgInput').setInputFiles(pfgPath);
    await page.locator('#biweeklySyscoInput').setInputFiles(syscoPath);
    await page.locator('#biweeklyGfsInput').setInputFiles(gfsPath);

    await expect(page.locator('#biweeklyInventoryFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklyMappingFileList')).toContainText(/\.xlsx|\.xls/i, { timeout: 10_000 });
    await expect(page.locator('#biweeklyUsFoodsFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklyPfgFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklySyscoFileList')).toContainText('.csv', { timeout: 10_000 });
    await expect(page.locator('#biweeklyGfsFileList')).toContainText('.csv', { timeout: 10_000 });

    const btn = page.locator('#biweeklyProcessButton');
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();

    const results = page.locator('#biweeklyResults');
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results).toContainText(/recommendations/i, { timeout: 60_000 });

    if (process.env.PW_KEEP_OPEN === '1') {
      await context.waitForEvent('close', { timeout: 10 * 60 * 1000 }).catch(() => {});
    }
  });

  await context.close().catch(() => {});
});
