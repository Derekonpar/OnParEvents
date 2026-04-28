# Food Sheet Processing Tool - Project Scratchpad

## Background and Motivation

The user needs a localhost npm tool that:
1. Accepts party detail sheets (PDFs) - up to 10 at a time
2. Uses OpenAI API to extract information from uploaded PDFs
3. Converts food quantities based on guest count using a conversion table
4. Generates output with pan sizes for food items
5. Separates and calculates totals for:
   - Food
   - Drinks (Back Nine or Full Course drink components)
   - Entertainment (bowling, darts, etc.)
6. Handles three package types:
   - **Front Nine**: Food only
   - **Back Nine**: Drinks only (shows preloaded RFID amount)
   - **Full Course**: Food + Drinks (need to subtract drink costs from total to get food spend)

### Key Business Logic
- When a line item is "Full Course" for X people with $Y drink bracelets, the total includes both food and drinks
- To get food spend: Total - (X * Y) = Food Amount
- Drinks amount = X * Y
- Entertainment items (bowling, darts, etc.) are separate line items

## Key Challenges and Analysis

1. **PDF Parsing**: Need to use OpenAI Vision API to extract structured data from party detail PDFs
2. **Data Extraction**: Extract:
   - Guest count
   - Food items and quantities
   - Package types (Front Nine, Back Nine, Full Course)
   - Drink bracelet prices (for Back Nine/Full Course)
   - Entertainment items (bowling lanes, darts, etc.) with quantities and pricing
   - Event details (date, time, location, contact info)
3. **Food Conversion**: Apply conversion table rules:
   - Guest ranges: 1-25, 26-50, 51-75, 76-100, 101-125
   - Meat quantities (beef, chicken, pork) based on guest count
   - Tortilla calculation: guests * 3
   - Pan size assignments based on quantities
4. **Output Generation**: Create formatted output similar to the kitchen checklist with:
   - Event details
   - Food items with pan sizes and quantities
   - Entertainment items (separated)
   - Financial breakdown (Food total, Drinks total, Entertainment total)

## High-level Task Breakdown

### Phase 1: Project Setup
- [ ] Initialize npm project with package.json
- [ ] Install dependencies (Express, Multer for file uploads, OpenAI SDK, PDF parsing libraries)
- [ ] Set up basic Express server on localhost
- [ ] Create environment variable setup for OpenAI API key
- **Success Criteria**: Server runs on localhost, can accept file uploads

### Phase 2: File Upload System
- [ ] Create upload endpoint that accepts PDF files (up to 10)
- [ ] Implement file validation (PDF only, size limits)
- [ ] Store uploaded files temporarily
- [ ] Create UI for file upload (simple HTML form or React component)
- **Success Criteria**: Can upload multiple PDFs, files are validated and stored

### Phase 3: OpenAI Integration
- [ ] Set up OpenAI client with API key
- [ ] Create function to convert PDF to base64/image format for Vision API
- [ ] Design prompt for extracting party details from PDF
- [ ] Extract structured data: guest count, food items, package types, entertainment, pricing
- **Success Criteria**: Can extract key information from uploaded PDFs using OpenAI

### Phase 4: Food Conversion Logic
- [ ] Create conversion table data structure (from the food conversion sheet)
- [ ] Implement logic to determine meat quantities based on guest count ranges
- [ ] Implement tortilla calculation (guests * 3)
- [ ] Map food items to pan sizes based on quantities
- **Success Criteria**: Correctly converts guest counts to food quantities and pan sizes

### Phase 5: Financial Calculations
- [ ] Identify package types (Front Nine, Back Nine, Full Course)
- [ ] Calculate food spend (handle Full Course subtraction logic)
- [ ] Calculate drinks spend (Back Nine or Full Course drink components)
- [ ] Calculate entertainment spend (separate line items)
- [ ] Sum totals for each category
- **Success Criteria**: Correctly calculates and separates food, drinks, and entertainment totals

### Phase 6: Output Generation
- [ ] Create output format matching kitchen checklist structure
- [ ] Include event details (food runner, times, event name)
- [ ] List food items with pan sizes and quantities
- [ ] List entertainment items separately
- [ ] Display financial breakdown
- [ ] Export as PDF or formatted document
- **Success Criteria**: Generates complete output matching required format

### Phase 7: UI/UX Polish
- [ ] Create clean interface for uploading files
- [ ] Show processing status
- [ ] Display results in readable format
- [ ] Add download/export functionality
- [ ] Handle errors gracefully
- **Success Criteria**: User-friendly interface, clear feedback, exportable results

### Phase: US Foods Playwright — list download (Planner)
- **Goal**: Add a Playwright spec + npm script that logs into US Foods, navigates to **My Lists → “Fall 2025”**, clicks **Download**, clicks **Download options**, selects **Product prices**, then clicks **Download** to save the file locally.
- **Inputs (env)**:
  - `USFOODS_USERNAME`
  - `USFOODS_PASSWORD`
  - Optional: `USFOODS_URL`
  - Optional: `USFOODS_LIST_NAME` (defaults to `Fall 2025`)
- **Outputs**:
  - Downloaded file saved to `testInfo.outputPath('downloads')`
  - Download path printed to terminal output

#### Step A — Add spec + npm script
- **Work**:
  - Create `playwright/usfoods-list-download.spec.js`
  - Add `pw:usfoods` script to `package.json`
- **Success criteria**:
  - `npm run pw:usfoods -- --headed --trace on` launches and reaches login.

#### Step B — Login (robust)
- **Work**:
  - Use role/text locators for username/password/submit; handle redirects.
  - Add high-signal console + 401/403 response logging (like Sysco) to make failures obvious.
- **Success criteria**:
  - Post-login, “My Lists” is visible/clickable.

#### Step C — Navigate to list
- **Work**:
  - Click **My Lists** in the top nav.
  - Click list named **Fall 2025** (exact match with fallback regex).
  - Assert list page is ready by verifying the list title/header includes the list name.
- **Success criteria**:
  - The list header/title includes **Fall 2025**.

#### Step D — Download flow (exact user steps)
- **Work**:
  - Click **Download** (top right).
  - Click **Download options** in the popup/menu.
  - Select **Product prices** on the right (toggle/checkbox/radio).
  - Click final **Download** and wait for Playwright `download` event.
- **Success criteria**:
  - A download event occurs and the file exists on disk.

#### Step E (Optional) — Upload to localhost biweekly input
- **Work**:
  - Go to `http://localhost:3000` → “Biweekly Order Providers” tab.
  - Upload into the US Foods file input control.
- **Success criteria**:
  - UI shows the uploaded filename in the US Foods file list.

#### Step F — Stabilization + docs
- **Work**:
  - Avoid `networkidle` waits (polling sites).
  - Add trace-open instructions to README.
- **Success criteria**:
  - One clean run succeeds end-to-end; failures produce actionable trace + logs.

### Phase: Full automation tab (no US Foods) + one-command runner (Planner)
- **Goal**: Add a new tab (adjacent to “Biweekly Order Providers”) that accepts the same provider uploads **except US Foods**, and add a Playwright spec that, in a single browser session, **downloads** all vendor guides, **uploads** them into this new tab, then clicks **Get order totals** and leaves the results visible.
- **Non-goals**:
  - No US Foods automation in this phase.
  - Do not change existing “Biweekly Order Providers” behavior (keep backward compatible).

#### Step 0 — Site inspection + DOM contract (read-only)
- **Work**:
  - Identify current “Biweekly Order Providers” tab markup in `public/index.html`:
    - tab button label
    - tab container id
    - provider input ids and “file list” element ids
    - “Get order totals” button selector
    - results container selector (where recommendations appear)
  - Identify server endpoint(s) called by “Get order totals” in `server.js` (if any).
- **Success criteria**:
  - A written “DOM contract” list of selectors Playwright will use (ids preferred).

#### Step 1 — New tab UI (additive, unique ids)
- **Work**:
  - Add a new tab button next to the existing one.
  - Add a new tab panel duplicating the provider upload UI but **remove US Foods**.
  - Ensure all ids are unique (suggest suffix `Auto`), e.g.:
    - `#biweeklyPfgInputAuto`, `#biweeklySyscoInputAuto`, `#biweeklyGfsInputAuto`
    - file list elements: `#biweeklyPfgFileListAuto`, etc.
    - totals button: `#biweeklyGetTotalsAuto`
    - results container: `#biweeklyResultsAuto`
- **Success criteria**:
  - Manual test: you can upload 3 files into the new tab and click totals and see results, without impacting the original tab.

#### Step 2 — Logic wiring (reuse existing computation)
- **Work**:
  - Reuse existing computation by extracting functions that accept a “tab root element”, OR duplicate only minimal wiring if extraction risks regressions.
  - Ensure the new tab reads from its own inputs and renders into its own results container.
- **Success criteria**:
  - Same inputs produce same output as the original tab (minus US Foods).

#### Step 3 — Playwright E2E (single session, one command)
- **Work**:
  - Create a new spec (suggest `playwright/biweekly-auto-no-usfoods.spec.js`) that:
    - runs provider exports (PFG + Sysco + GFS) using existing vendor logic/helpers
    - opens `http://localhost:3000`
    - switches to the new tab
    - uploads the 3 downloaded files into the new tab inputs
    - clicks **Get order totals**
    - asserts results are non-empty (at least one recommendation line)
  - Add `npm run pw:biweekly-auto` script.
- **Success criteria**:
  - One run downloads 3 files, uploads 3 files, clicks totals, and shows recommendations.

#### Step 4 — Fast debug on failure
- **Work**:
  - Avoid `networkidle`; use explicit ready checks.
  - Capture high-signal 401/403 + page errors in thrown messages.
  - Keep trace/video/screenshot on failure.
- **Success criteria**:
  - Failures are diagnosable in <2 minutes via trace.

#### Step 5 — Simple runbook
- **Work**:
  - Document 2-command run flow in `README.md`:
    - start server
    - run automation
    - open trace when needed
- **Success criteria**:
  - You can copy/paste the steps without touching code.

## Project Status Board

- [ ] Phase 1: Project Setup
- [ ] Phase 2: File Upload System
- [ ] Phase 3: OpenAI Integration
- [ ] Phase 4: Food Conversion Logic
- [ ] Phase 5: Financial Calculations
- [ ] Phase 6: Output Generation
- [ ] Phase 7: UI/UX Polish
- [ ] US Foods Playwright: Step A (spec + npm script)
- [ ] US Foods Playwright: Step B (login)
- [ ] US Foods Playwright: Step C (navigate to list)
- [ ] US Foods Playwright: Step D (download options + product prices + download)
- [ ] US Foods Playwright: Step E (optional upload to localhost)

## Current Status / Progress Tracking

**Current Phase**: Phase 1-6 Complete - Enhanced with Line Items & Combined Totals

**Completed**:
- ✅ Initialized npm project with all dependencies
- ✅ Set up Express server on localhost:3000
- ✅ Created file upload system (supports up to 10 PDFs/PNGs)
- ✅ Built modern web UI with drag-and-drop
- ✅ Integrated OpenAI API for PDF text extraction and PNG image analysis
- ✅ Implemented cost breakdown logic with preloaded drinks handling
- ✅ Created results display with categorized costs
- ✅ Added Booking Fee category support
- ✅ Added detailed line items breakdown (grouped by category)
- ✅ Added combined totals across all files when multiple files uploaded
- ✅ Enhanced entertainment item detection (bowling, darts, karaoke, shuffleboard, mini golf)

**Clarifications from User**:
- This is a portal for "all things food" on localhost
- OpenAI API will analyze party sheets and break down costs automatically
- When uploading PDF, OpenAI will identify: bowling, darts, food, etc.
- **Critical Logic**: If "preloaded drinks" are mentioned, subtract that amount from food total and add to drinks total

### Playwright automation (vendor exports)
In addition to the PDF portal, we are maintaining Playwright automations to export vendor lists/prices (PFG/GFS/Sysco complete). Next up: **US Foods** list download for “Fall 2025”.

### New request (Planner): Full provider automation tab + one-command run
The user wants a **new UI tab** next to “Biweekly Order Providers” that is **the same workflow**, but:
- **No US Foods slot**
- In one Playwright run session, it will:
  - Download/export all provider order guides (PFG, Sysco, GFS; US Foods excluded for now)
  - Upload them into this new tab’s inputs
  - Click **Get order totals** at the bottom
  - Show which items to order from which vendor

**Hard constraint (from user)**: For this planning step, do not edit any existing code. Implementation will be done later in Executor steps after plan approval.

### Follow-up request (Planner): “Run automation” button + Google Sheets linking (minimize manual steps)
User wants:
- A UI button that can trigger the Playwright automation (so they don’t have to run a command manually).
- The automation to automatically pull the **Mapping** and **Order Sheet / Inventory** from Google Sheets (so they don’t have to upload/update files).
- Keep file types consistent with existing biweekly uploader rules (**CSV** and **Excel** only).

#### File type constraints (current app)
- **Biweekly UI** expects:
  - Inventory / order sheet: **CSV** (`accept=".csv"`)
  - Provider price files: **CSV** (`accept=".csv"`)
  - Mapping sheet: **Excel** (`accept=".xlsx,.xls"`)
- **Backend (`biweeklyUpload`) accepts**: **CSV or Excel** (by mimetype or file extension).
- Therefore, if we link Google Sheets:
  - Inventory sheet should be fetched as **CSV**
  - Mapping sheet should be fetched as **XLSX** (Google can export a Sheet as `.xlsx`)

### Phase: Automation button + Google Sheets inputs (Planner)
#### Step 6 — Add “Run Automation” button (safe local trigger)
- **What it does**:
  - UI button calls a local server endpoint (example: `POST /api/run-biweekly-auto-no-usfoods`)
  - Server spawns the Playwright run (the same thing you’d do with `npm run pw:biweekly-auto`)
  - UI shows progress: “Starting… / Running… / Done / Failed” and links to trace zip path on failure.
- **Why this is needed**:
  - A website cannot start Command Prompt directly; it must ask the **server** to run it.
- **Safety**:
  - Only allow this endpoint on localhost (reject non-local requests)
  - Add a simple in-memory lock so only one run at a time
- **Success criteria**:
  - Clicking the button launches the automation and returns a “done” response without manual terminal commands.

#### Step 7 — Link Google Sheets for Inventory + Mapping (no manual uploads)
- **Approach A (recommended)**: Use Google’s “export” URLs (no credentials) for Sheets that can be shared/published.
  - Inventory CSV: export as `format=csv`
  - Mapping XLSX: export as `format=xlsx`
- **Approach B**: Google Sheets API + credentials (private sheets; more setup).
- **Implementation shape**:
  - Add two optional `.env` vars (names TBD):
    - `BIWEEKLY_INVENTORY_SHEET_URL` (CSV export URL)
    - `BIWEEKLY_MAPPING_SHEET_URL` (XLSX export URL)
  - On “Run Automation”, the server downloads these files to a temp folder and passes paths to Playwright (or uploads them directly via Playwright `setInputFiles`).
- **Success criteria**:
  - With sheet URLs set, user does not upload inventory/mapping manually; run produces results from latest sheet data.

##### Approach A details (exact URL formats)
- **Prereq**: the Google Sheet must be shareable by link (or published). For simplest reliability, set **General access** to “Anyone with the link can view”.
- From a normal Sheets URL like:
  - `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit#gid=<GID>`
- Use export URLs:
  - **Inventory (CSV)**:
    - `https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>`
  - **Mapping (XLSX)**:
    - `https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=xlsx&gid=<GID>`
- **Notes**:
  - `gid` selects the tab inside the sheet.
  - CSV export is perfect for the inventory/order sheet input (the UI already expects `.csv`).
  - XLSX export is perfect for the mapping input (UI expects `.xlsx/.xls`).

##### Env example (Approach A)
- Add to `.env`:
  - `BIWEEKLY_INVENTORY_SHEET_URL="https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>"`
  - `BIWEEKLY_MAPPING_SHEET_URL="https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=xlsx&gid=<GID>"`

##### Validation rules (to avoid silent mistakes)
- On download, validate:
  - Inventory response has a `.csv` filename OR `content-type` includes `text/csv`
  - Mapping response has `.xlsx` extension OR `content-type` includes an Excel mimetype

#### Step 8 — Min-manual provider inputs during automation
- **Goal**: In a single Playwright session:
  - download PFG/Sysco/GFS price files (CSV)
  - fetch inventory/mapping from Sheets (CSV + XLSX)
  - upload all into the “No US Foods” tab
  - click “Generate Order Plan”
- **Success criteria**:
  - `npm start` then one click triggers a full run and displays recommendations.

## Executor: Step 0 (DOM + API contract for Biweekly tab)
### Current UI selectors (existing “Biweekly Order Providers” tab)
- **Tab button label**: `Biweekly Order Providers` (tab switches to `#biweekly-order`)
- **Tab panel id**: `#biweekly-order`
- **Inventory CSV**
  - input: `#biweeklyInventoryInput`
  - file list: `#biweeklyInventoryFileList`
- **Provider CSV inputs**
  - US Foods: `#biweeklyUsFoodsInput` → list `#biweeklyUsFoodsFileList`
  - PFG: `#biweeklyPfgInput` → list `#biweeklyPfgFileList`
  - Sysco: `#biweeklySyscoInput` → list `#biweeklySyscoFileList`
  - GFS: `#biweeklyGfsInput` → list `#biweeklyGfsFileList`
- **Mapping sheet**
  - input: `#biweeklyMappingInput`
  - file list: `#biweeklyMappingFileList`
- **Get totals button (currently labeled “Generate Order Plan”)**
  - button id: `#biweeklyProcessButton`
  - onclick: `processBiweeklyOrder()`
- **Loading indicator**: `#biweeklyLoading`
- **Results container**: `#biweeklyResults`

### Current API contract (server)
- **Endpoint**: `POST /api/biweekly-order`
- **Form fields required** (multipart):
  - `inventoryCsv`
  - `usFoodsCsv`
  - `pfgCsv`
  - `syscoCsv`
  - `gfsCsv`
  - `mappingSheet`
- **Important implication**: a “no US Foods” tab/run cannot call this endpoint as-is; we will need either:
  - a new endpoint (e.g. `/api/biweekly-order-no-usfoods`) OR
  - make `usFoodsCsv` optional on the existing endpoint (but that edits existing behavior), OR
  - provide a dummy US Foods CSV automatically (hacky; not recommended).

## Executor: Step 1 (UI) — In progress
- Added new tab button: **“Biweekly Order Automation (No US Foods)”** → panel id `#biweekly-order-auto`
- Added new tab panel with unique ids:
  - Inventory: `#biweeklyAutoInventoryInput` / `#biweeklyAutoInventoryFileList`
  - PFG: `#biweeklyAutoPfgInput` / `#biweeklyAutoPfgFileList`
  - Sysco: `#biweeklyAutoSyscoInput` / `#biweeklyAutoSyscoFileList`
  - GFS: `#biweeklyAutoGfsInput` / `#biweeklyAutoGfsFileList`
  - Mapping: `#biweeklyAutoMappingInput` / `#biweeklyAutoMappingFileList`
  - Button: `#biweeklyAutoProcessButton` (disabled until Step 2 wiring)
  - Results: `#biweeklyAutoResults`

**Next Steps**: 
- User needs to create `.env` file with `OPENAI_API_KEY`
- Test with actual party detail PDFs
- Verify cost breakdown calculations

## Planner: Biweekly accuracy — mapping, inventory, and “why did it pick Sysco?”

### What the code does today (ground truth in `server.js`)
- **Inventory CSV parsing** is *fixed*:
  - Product name: **column B** (index 1)
  - Quantity: **column K** (index 10)
  - Starts at **row 2** in the CSV
  - It **ignores** qty ≤ 0 and **sums** duplicate product names
- **Mapping XLSX** is built in `buildProductMappingFromExcel()`:
  - Picks a **reference** column heuristically (header includes words like `reference` / `target` / `match` / `standard`); if none match, it defaults to **col A**
  - Treats *every other column* as “invoice/provider alias columns”
- **Provider CSVs** (fixed product/price columns + start rows):
  - PFG: product **A**, price **H**, start **row 9**
  - GFS: product **B**, price **E**, start **row 2**
  - Sysco: product **M**, price **O**, start **row 3**
- **Price selection**:
  - Per vendor+canonical product, if multiple rows map, biweekly path uses `upsertMax` → **higher** unit price (intended to handle case/pack)
  - Then picks **lowest** unit price *across vendors* for the buy recommendation

### Likely root causes of your symptoms
1) **Reference column / mapping columns not what the heuristics assume**  
   If the canonical name column is not the detected “reference” column, provider aliases can end up mapped incorrectly or not at all.
2) **Inventory product strings don’t match canonical names exactly** (case, punctuation, “Milwaukee” vs `MILWAUKEE`, extra spaces)  
   The inventory `Map` key is the raw `row[1]` string; the recommendation loop keys off that exact string.
3) **GFS / PFG provider rows not mapping to the same canonical key as Sysco**  
   Then Sysco “wins by default” because it’s the only vendor with a numeric price for that canonical product.
4) **Pack/case rule (`upsertMax`)** can make a vendor’s unit price *higher than the single-pack line you expect*, skewing cross-vendor comparison.

### Concrete improvement plan (Executor tasks)
#### A — Make mapping sheet interpretation explicit and stable
- Add optional `.env` / server config to force:
  - `BIWEEKLY_REFERENCE_COLUMN` = letter or index (e.g. `A` or `1`)
  - `BIWEEKLY_PFG_MAP_COL`, `BIWEEKLY_GFS_MAP_COL`, `BIWEEKLY_SYSCO_MAP_COL` (optional)  
  so we are not dependent on “first non-reference column = PFG” mental model.
- Or standardize the mapping workbook to have headers exactly: `Reference | US Foods | PFG | Sysco | GFS` and read by header.

#### B — Harden name normalization and matching
- Apply the **same** normalization to inventory keys and mapping keys (today inventory uses raw strings).
- Add targeted fuzzy rules (tokens): strip brand words, collapse punctuation, handle `'` vs `’`, `1/2` vs `½`, `LB` vs `LBS`, etc.
- Add a “debug match” for a product: show *which provider rows* contributed prices.

#### C — Add diagnostics in API response (and optionally UI) for a single run
- For each **canonical product in inventory**, return:
  - which vendors had a mapped price
  - the chosen unit price per vendor (pre-min)
  - whether fuzzy match was used
- This will make cases like “diced tomatoes” provable: we’ll see if GFS price exists in the parsed `providerPriceByVendor` map for that key.

#### D — Validation tests (small fixtures)
- Create tiny CSV/XLSX fixtures in `tmp-biweekly-test/`:
  - inventory row for **Diced Tomatoes** qty > 0
  - GFS order guide line with product text exactly as mapping
  - Sysco line present but more expensive
- Assert: recommendation vendor = GFS and price = expected.

### Success criteria
- **Diced tomatoes** example resolves to the vendor you expect when mapping + guides agree.
- **Milwaukee pretzel / burger patties** show up if they exist in the exported inventory CSV with qty > 0 in **B/K**; if not, we get a clear diagnostic explaining whether it was **qty 0 / missing / duplicate key mismatch** rather than a silent wrong vendor.

## Executor's Feedback or Assistance Requests

**No–US‑foods fuzzy scope (Executor, 2026-04-27)**:
- Implemented in `server.js`: `buildProductMappingFromExcelFixedColumns` returns `refsNoPrimaryPfg`, `refsNoPrimarySysco`, `refsNoPrimaryGfs` (reference names whose B/D/E cell is blank). `/api/biweekly-order-no-usfoods` passes those lists into `extractProviderPricesFromSingleCsvRows` / `matchProviderToMappingProduct` as the fuzzy candidate set; if a list is empty (every row had that primary filled), it falls back to full `referenceProducts`. Heuristic mapping mode uses full `referenceProducts` for all three lists (same as 4‑vendor behavior).
- Verified: `POST /api/biweekly-order-no-usfoods` with `tmp-biweekly-test/*` uploads returns `success: true` and sensible `matchedRecords` / recommendations.

*Starting implementation now - building the portal*

US Foods Playwright (Executor):
- Implemented **Step A**: added `playwright/usfoods-list-download.spec.js` skeleton and `npm run pw:usfoods`.
- Verified **Step A**: `npm run pw:usfoods -- --trace on` reaches the US Foods login entry page (User ID + Log in) and passes.
- Ready for Step B (login) once Planner/user approves proceeding.

**Biweekly mapping (Executor, 2026-04-24)**:
- User confirmed: **Column C in the mapping sheet = US Foods**. The no‑US‑foods (`/api/biweekly-order-no-usfoods`) run must not use C for matching.
- `server.js`: `buildProductMappingFromExcel` now accepts `includeUsFoodsColumn` (default **true** for the 4‑vendor `/api/biweekly-order` path). The no‑US‑foods path passes **`includeUsFoodsColumn: false`**, which skips col C in both the primary and “extra column” alias scan.

**Inventory ↔ reference + fuzzy (Executor, follow-up)**:
- Clarification for user: the earlier “point 3” in the checklist was **use the no‑US‑foods API** for that tab, not “column 3.”
- Root cause of missing PFG/GFS prices: provider price maps are keyed by **mapping col A (reference)**, but the loop was looking up with **raw inventory col B** only when strings matched exactly. **Fix:** `resolveInventoryToReferenceProductName()` (exact, normalized, alias via `productMapping`, then `matchProductName` fuzzy) before reading vendor unit prices. Applied to both `/api/biweekly-order` and `/api/biweekly-order-no-usfoods`.
- `BIWEEKLY_MAPPING_LAYOUT=auto` + no‑US‑foods: heuristic header import now **skips columns whose header looks like US Foods** when `includeUsFoodsColumn: false`.
- `public/index.html`: removed **duplicate** `displayBiweeklyResults` that was overriding the one-line wrapper; shared `displayBiweeklyResultsInto` now shows `referenceProduct` when it differs and optional `matchedRecords` line.

## Lessons

*To be filled during implementation*

- Biweekly **fixed** mapping layout (`BIWEEKLY_MAPPING_LAYOUT=fixed` default): A = reference, B = PFG, **C = US Foods (only for `/api/biweekly-order` when `includeUsFoodsColumn` is true)**, D = Sysco, E = GFS. `/api/biweekly-order-no-usfoods` passes `includeUsFoodsColumn: false` so col C is ignored entirely (no accidental cross-vendor alias bleed).

- GFS Playwright: login is **two pages** (username + Continue, then password + **Verify**). Post-login modal: **Just browsing** only. **Guides** is in the bar **below the search box** (not top header); test picks leftmost “Guides” below the search band via bounding boxes. **Order guide** / export: retries with short delays if flaky.
- Sysco Playwright tribulations + fixes:
  - **Flaky / “can’t click ⋮”**: initial logic was either double-clicking (which can close the menu) or aiming at wrappers instead of the actual icon button. Fix: click **once**, avoid Enter, and target **real icon-button candidates** (`more_vert` material icon / aria-label / `data-id`) with a **size sanity check** so we don’t click a full-width container.
  - **Frame confusion**: Sysco can render parts of the list UI in an iframe. Fix: search **main page + every frame** for the ⋮ and export menu, and fall back to `element.click()` via `frame.evaluate()` when pointer clicks are blocked.
  - **Auth/session noise looked like the root cause**: console showed 401/session validation errors while UI still partially rendered. Fix: log only high-signal console/network errors into the failure message so we can distinguish “real auth break” from “selector/click break.”
  - **The real hang was `networkidle`**: Sysco keeps polling so `waitForLoadState('networkidle')` can burn the whole test timeout before we ever reach the ⋮ step. Fix: switch those waits to **`domcontentloaded`**.
  - **Misleading error line (`setViewportSize` after timeout)**: when the test times out, the page is closed and the next awaited call throws. Fix: set viewport **at the top of the test**, before long waits.
  - **Result**: `pw:sysco` now reliably opens the list, clicks ⋮, selects **Export List…**, and proceeds with the export/upload flow.
- Vendor cost management: when adding another supplier with manual (undated) invoices, mirror the existing Sysco flow by adding (1) a UI section in `public/index.html` that captures one file + one date per row, and (2) server-side parsing in `server.js` via a vendor-specific extractor that uses fixed Excel column indexes.
- Implemented US Foods manual-date parsing:
  - Excel columns: `B` = product name, `G` = unit price
  - Skip row 1 header (start from row 2)

- Biweekly Order Providers tab:
  - Uploads: Inventory CSV (product `B`, qty `K`, start row 2) + Mapping Excel + 4 provider CSVs (US Foods / PFG / Sysco / GFS) into the new third tab.
  - Provider CSV parsing (fixed columns + row starts):
    - US Foods: product `D`, price `H`, start row 2
    - PFG: product `A`, price `H`, start row 9
    - Sysco: product `M`, price `O`, start row 3
    - GFS: product `B`, price `E`, start row 2
  - Pack-size rule: if multiple provider rows map to the same canonical product for the same vendor (single vs 4-pack/case), choose the **more expensive** unit price for that vendor+product (case/4-pack) before comparing vendors.
  - UI note: recommendations show a short note when multiple pack options were found and case/4-pack pricing was used.

## Data Structures Reference

### Party Detail Sheet Structure (from images):
- Event Contract: Account, Contact, Email, Phone, Address
- Event Summary: Date, Time, Location, Areas, Event Type, Guests, Rental, Event F&B Min
- Food Section: Items with Qty, Description, Price, Total
- Additional Charges: Entertainment items (Darts, Duckpin Bowling) with quantities and pricing

### Food Conversion Table Structure:
- Guest Ranges: 1-25, 26-50, 51-75, 76-100, 101-125
- Meat Quantities per range:
  - 1-25: 5 lbs beef, 5 lbs chicken, 2.5 lbs pork
  - 26-50: 10 lbs beef, 10 lbs chicken, 5 lbs pork
  - 51-75: 15 lbs beef, 15 lbs chicken, 7.5 lbs pork
  - 76-100: 20 lbs beef, 20 lbs chicken, 10 lbs pork
  - 101-125: 25 lbs beef, 25 lbs chicken, 12.5 lbs pork
- Tortillas: Guests * 3
- Dessert: 1/2 cookie per guest

### Output Format (Kitchen Checklist):
- Event Details: Food Runner, Start Time, Earliest Prep Time, Food Ready By
- Food Items Table: Food Name, # Pans, Pan Size, Item #, Add-ons
- Entertainment Section (separate)
- Financial Summary: Food Total, Drinks Total, Entertainment Total

