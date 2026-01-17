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

## Project Status Board

- [ ] Phase 1: Project Setup
- [ ] Phase 2: File Upload System
- [ ] Phase 3: OpenAI Integration
- [ ] Phase 4: Food Conversion Logic
- [ ] Phase 5: Financial Calculations
- [ ] Phase 6: Output Generation
- [ ] Phase 7: UI/UX Polish

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

**Next Steps**: 
- User needs to create `.env` file with `OPENAI_API_KEY`
- Test with actual party detail PDFs
- Verify cost breakdown calculations

## Executor's Feedback or Assistance Requests

*Starting implementation now - building the portal*

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

