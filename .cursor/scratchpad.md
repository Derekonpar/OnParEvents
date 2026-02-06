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

### New Feature: Vendor Cost Management

The user now wants to add a new tab called "Vendor Cost Management" that:
1. Accepts Excel files from different suppliers/vendors (multiple files can be uploaded)
2. Each Excel file may have different column structures/headers
3. Extracts key data from each Excel file:
   - Product description/name
   - Unit price
   - Date (date of ordering/invoice)
4. Compares extracted data to a main reference sheet that contains line items by product name
5. Matches invoices by date of ordering (not all items may appear in every invoice)
6. Outputs:
   - Same reference columns with prices for each item scraped from uploaded sheets
   - Data organized/stored by date
   - For each product item: a line plot showing prices over time
   - Average price displayed underneath each plot

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

### Vendor Cost Management Challenges

1. **Excel File Parsing**: Need to handle Excel files (.xlsx, .xls) with varying column structures
   - Different suppliers may use different column names/headers
   - Need to intelligently identify: product description, unit price, date columns
   - May need to use OpenAI to help identify column mappings for each file
2. **Data Normalization**: 
   - Match product names across different files (may have slight variations in naming)
   - Handle date parsing from various formats
   - Normalize price formats (currency symbols, decimals, etc.)
3. **Main Reference Sheet**: 
   - Need to upload/define a main sheet with reference product names
   - Match extracted products to reference products (fuzzy matching may be needed)
4. **Data Storage by Date**: 
   - Organize all extracted prices by date
   - Track which supplier/file each price came from
5. **Visualization**: 
   - Generate line plots for each product showing price over time
   - Calculate and display average price for each product
   - Use a charting library (Chart.js, D3.js, or similar)

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

### Phase 8: Vendor Cost Management Feature
- [ ] Add tab navigation to UI (Party Sheet Analyzer + Vendor Cost Management)
- [ ] Install Excel parsing library (xlsx, exceljs, or similar)
- [ ] Create Excel file upload endpoint (accepts .xlsx, .xls files)
- [ ] Implement main reference sheet upload/definition
- [ ] Create OpenAI prompt to identify column mappings (product description, unit price, date) from Excel files
- [ ] Parse Excel files and extract: product description, unit price, date
- [ ] Normalize product names (fuzzy matching against reference sheet)
- [ ] Normalize dates and prices
- [ ] Store extracted data organized by date
- [ ] Match products to reference sheet items
- [ ] Install charting library (Chart.js recommended)
- [ ] Create visualization component for price trends (line plots per product)
- [ ] Calculate and display average price for each product
- [ ] Create UI for Vendor Cost Management tab with:
  - Upload area for main reference sheet
  - Upload area for vendor Excel files (multiple)
  - Results display with product list
  - Price trend charts for each product
  - Average prices displayed
- **Success Criteria**: Can upload Excel files, extract product/price/date data, match to reference sheet, display price trends over time with averages

## Project Status Board

- [x] Phase 1: Project Setup
- [x] Phase 2: File Upload System
- [x] Phase 3: OpenAI Integration
- [x] Phase 4: Food Conversion Logic
- [x] Phase 5: Financial Calculations
- [x] Phase 6: Output Generation
- [x] Phase 7: UI/UX Polish
- [ ] Phase 8: Vendor Cost Management Feature

## Current Status / Progress Tracking

**Current Phase**: Phase 8 Complete - Vendor Cost Management Feature Implemented

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
- ✅ **NEW**: Added tab navigation (Party Sheet Analyzer + Vendor Cost Management)
- ✅ **NEW**: Installed exceljs and Chart.js dependencies
- ✅ **NEW**: Created Excel file upload endpoint (`/api/vendor-costs`)
- ✅ **NEW**: Implemented OpenAI-based column identification for Excel files
- ✅ **NEW**: Created main reference sheet upload functionality
- ✅ **NEW**: Implemented fuzzy product name matching
- ✅ **NEW**: Organized extracted data by date and product
- ✅ **NEW**: Created Vendor Cost Management UI tab with upload areas
- ✅ **NEW**: Implemented price trend visualization with Chart.js line plots
- ✅ **NEW**: Calculate and display average prices for each product

**Clarifications from User**:
- This is a portal for "all things food" on localhost
- OpenAI API will analyze party sheets and break down costs automatically
- When uploading PDF, OpenAI will identify: bowling, darts, food, etc.
- **Critical Logic**: If "preloaded drinks" are mentioned, subtract that amount from food total and add to drinks total

**Next Steps**: 
- ✅ User created `.env` file with `OPENAI_API_KEY` (fixed variable name from OPEN_API_KEY to OPENAI_API_KEY)
- ✅ Vendor Cost Management feature implemented (Phase 8)
- Test with actual party detail PDFs
- Test Vendor Cost Management with actual Excel files from vendors
- Verify Excel column identification works with various file formats
- Verify product name matching accuracy

## Executor's Feedback or Assistance Requests

**Vendor Cost Management Implementation Complete**:
- All Phase 8 tasks completed
- Feature is ready for testing with actual Excel files
- The system will:
  1. Accept a reference Excel sheet with product names
  2. Accept multiple vendor Excel files (different suppliers)
  3. Use OpenAI to intelligently identify columns (product description, unit price, date)
  4. Extract and match products using fuzzy matching
  5. Display price trends over time with line charts
  6. Show average prices for each product

**Testing Recommendations**:
- Test with various Excel file formats and column structures
- Verify that OpenAI column identification works correctly
- Test product name matching with slight variations in naming
- Ensure date parsing handles different date formats

## Lessons

*To be filled during implementation*

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

### Vendor Cost Management Data Structure:
- **Main Reference Sheet**: Array of product objects with standardized names
- **Extracted Invoice Data**: 
  - Array of invoice objects, each containing:
    - sourceFile: filename
    - date: Date object
    - items: Array of { productName, unitPrice, ...other columns }
- **Processed Data by Product**:
  - For each reference product:
    - productName: string
    - priceHistory: Array of { date, price, sourceFile }
    - averagePrice: number
    - priceChart: Chart.js line plot data

