const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');
const ExcelJS = require('exceljs');
const os = require('os');
const fssync = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configure multer for file uploads
// Use /tmp directory on Vercel (serverless), otherwise use ./uploads for local
const uploadDir = process.env.VERCEL || process.env.NOW ? '/tmp' : './uploads';
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // /tmp already exists on Vercel, only create directory for local
      if (!process.env.VERCEL && !process.env.NOW) {
        await fs.mkdir(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || 
        file.mimetype === 'image/png' || 
        file.mimetype === 'image/jpeg' || 
        file.mimetype === 'image/jpg') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, PNG, and JPEG files are allowed'));
    }
  }
});

// Multer for Excel files (vendor cost management)
const excelUpload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit for Excel files
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
  }
});

// Multer for CSV + Excel (biweekly provider ordering)
const biweeklyUpload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: (req, file, cb) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/csv' ||
      file.originalname.endsWith('.csv');

    const isExcel =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls');

    if (isCsv || isExcel) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files (.csv, .xlsx, .xls) are allowed'));
    }
  }
});

async function downloadUrlToFile(url, targetPath, { expectExt, expectContentTypes }) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download (${res.status}) from ${url}`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (expectContentTypes && expectContentTypes.length > 0) {
    const ok = expectContentTypes.some((t) => ct.includes(t));
    if (!ok) {
      throw new Error(`Unexpected content-type "${ct}" for ${url}`);
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(targetPath, buf);
  if (expectExt && !targetPath.toLowerCase().endsWith(expectExt)) {
    throw new Error(`Downloaded file path does not end with ${expectExt}: ${targetPath}`);
  }
  return { contentType: ct, bytes: buf.length };
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Convert PDF to base64 for OpenAI Vision API
async function pdfToBase64(pdfPath) {
  try {
    const pdfBuffer = await fs.readFile(pdfPath);
    return pdfBuffer.toString('base64');
  } catch (error) {
    throw new Error(`Error reading PDF: ${error.message}`);
  }
}

// Convert image to base64
async function imageToBase64(imagePath) {
  try {
    const imageBuffer = await fs.readFile(imagePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    throw new Error(`Error reading image: ${error.message}`);
  }
}

// Analyze party sheet (PDF or PNG) with OpenAI
async function analyzePartySheet(filePath, mimeType) {
  try {
    const systemPrompt = `You are an expert at analyzing party event contracts and extracting financial information from documents or images. 
          Extract all line items and categorize them into:
          1. FOOD - food items including:
             - Packages like "Front Nine", "Full Course" (food portion), taco bars
             - Food platters: wings, tater kegs, pretzel bites, garden salad, vegetable trays, chicken tenders, cookies, sauces, loaded fries, beer cheese, and any other food items
             - Each food platter item should be listed as a separate line item with its quantity, price, and total
          2. DRINKS - drink packages like "Back Nine", preloaded RFID amounts, drink bracelets, preloaded drinks
          3. ENTERTAINMENT - categorize each entertainment item specifically:
             - BOWLING - bowling lanes, duckpin bowling
             - DARTS - darts lanes, dart games
             - MINI_GOLF - mini golf
             - SHUFFLEBOARD - shuffleboard
             - KARAOKE - karaoke
             - OTHER_ENTERTAINMENT - any other entertainment items
          4. BOOKING_FEE - any booking fees, setup fees, or administrative charges
          
          IMPORTANT RULES FOR COST BREAKDOWN:
          - If you see "Full Course" for X people with $Y drink bracelets/preloaded drinks:
            * The total amount includes both food and drinks
            * Calculate drinks amount = X * Y
            * Food amount = total - drinks amount
            * Set preloadedDrinks object with quantity, pricePerPerson, and total
          
          - "Front Nine" = Food only
          - "Back Nine" = Drinks only (preloaded RFID amount)
          - "Full Course" = Food + Drinks (must split)
          
          - Look for entertainment items like:
            * Bowling lanes (per hour, per lane)
            * Darts (per hour, per lane)
            * Duckpin Bowling (per hour, per lane)
            * Karaoke
            * Shuffleboard
            * Mini Golf
          
          - Look for booking fees at the bottom of the document - these should be categorized as BOOKING_FEE
          
          Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
          {
            "eventDetails": {
              "eventName": "string or null",
              "date": "string or null",
              "time": "string or null",
              "guests": number or null,
              "contact": "string or null"
            },
            "lineItems": [
              {
                "description": "string",
                "quantity": number,
                "unitPrice": number,
                "total": number,
                "category": "FOOD" | "DRINKS" | "BOWLING" | "DARTS" | "MINI_GOLF" | "SHUFFLEBOARD" | "KARAOKE" | "OTHER_ENTERTAINMENT" | "BOOKING_FEE",
                "notes": "string or null"
              }
            ],
            "preloadedDrinks": {
              "quantity": number,
              "pricePerPerson": number,
              "total": number
            } or null
          }
          
          Make sure all numbers are actual numbers, not strings. Calculate totals correctly.`;

    let messages;

    if (mimeType === 'application/pdf') {
      // Handle PDF: use Vision API (same as PNG)
      const base64Pdf = await pdfToBase64(filePath);
      messages = [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this party event contract PDF and extract the financial breakdown:"
            },
            {
              type: "image_url",
              image_url: {
                url: `data:application/pdf;base64,${base64Pdf}`
              }
            }
          ]
        }
      ];
    } else if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      // Handle images (PNG, JPEG): use Vision API
      const base64Image = await imageToBase64(filePath);
      const imageMimeType = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'image/jpeg' : 'image/png';
      messages = [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this party event contract image and extract the financial breakdown:"
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageMimeType};base64,${base64Image}`
              }
            }
          ]
        }
      ];
    } else {
      throw new Error('Unsupported file type');
    }
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      response_format: { type: "json_object" },
      max_tokens: 2000
    });

    const content = response.choices[0].message.content;
    
    // Parse JSON response
    let jsonData;
    try {
      jsonData = JSON.parse(content);
    } catch (parseError) {
      // Try to extract JSON if wrapped in markdown
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Could not parse JSON from OpenAI response: ${content.substring(0, 200)}`);
      }
    }

    // Log line items for debugging
    if (jsonData.lineItems) {
      console.log(`Found ${jsonData.lineItems.length} line items`);
      if (jsonData.lineItems.length > 0) {
        console.log('Sample line item:', JSON.stringify(jsonData.lineItems[0], null, 2));
      }
    } else {
      console.log('No lineItems found in OpenAI response');
    }

    return jsonData;
  } catch (error) {
    throw new Error(`OpenAI analysis error: ${error.message}`);
  }
}

// Process cost breakdown
function processCostBreakdown(analysisResult) {
  let foodTotal = 0;
  let drinksTotal = 0;
  let bowlingTotal = 0;
  let dartsTotal = 0;
  let miniGolfTotal = 0;
  let shuffleboardTotal = 0;
  let karaokeTotal = 0;
  let otherEntertainmentTotal = 0;
  let bookingFeeTotal = 0;

  // Process line items
  if (analysisResult.lineItems && Array.isArray(analysisResult.lineItems)) {
    analysisResult.lineItems.forEach(item => {
      const amount = item.total || 0;
      const category = item.category || '';
      
      if (category === 'FOOD') {
        foodTotal += amount;
      } else if (category === 'DRINKS') {
        drinksTotal += amount;
      } else if (category === 'BOWLING') {
        bowlingTotal += amount;
      } else if (category === 'DARTS') {
        dartsTotal += amount;
      } else if (category === 'MINI_GOLF') {
        miniGolfTotal += amount;
      } else if (category === 'SHUFFLEBOARD') {
        shuffleboardTotal += amount;
      } else if (category === 'KARAOKE') {
        karaokeTotal += amount;
      } else if (category === 'OTHER_ENTERTAINMENT' || category === 'ENTERTAINMENT') {
        // Handle legacy ENTERTAINMENT category or other entertainment
        otherEntertainmentTotal += amount;
      } else if (category === 'BOOKING_FEE') {
        bookingFeeTotal += amount;
      }
    });
  }

  // Handle preloaded drinks - subtract from food, add to drinks
  if (analysisResult.preloadedDrinks && analysisResult.preloadedDrinks.total) {
    const preloadedAmount = analysisResult.preloadedDrinks.total;
    foodTotal = Math.max(0, foodTotal - preloadedAmount);
    drinksTotal += preloadedAmount;
  }

  // Calculate total entertainment for backward compatibility
  const entertainmentTotal = bowlingTotal + dartsTotal + miniGolfTotal + shuffleboardTotal + karaokeTotal + otherEntertainmentTotal;

  // Also check if totals are provided directly (legacy support)
  if (analysisResult.totals) {
    if (analysisResult.totals.food !== undefined) {
      foodTotal = analysisResult.totals.food;
    }
    if (analysisResult.totals.drinks !== undefined) {
      drinksTotal = analysisResult.totals.drinks;
    }
    if (analysisResult.totals.bookingFee !== undefined) {
      bookingFeeTotal = analysisResult.totals.bookingFee;
    }
  }

  const grandTotal = foodTotal + drinksTotal + entertainmentTotal + bookingFeeTotal;

  return {
    food: parseFloat(foodTotal.toFixed(2)),
    drinks: parseFloat(drinksTotal.toFixed(2)),
    bowling: parseFloat(bowlingTotal.toFixed(2)),
    darts: parseFloat(dartsTotal.toFixed(2)),
    miniGolf: parseFloat(miniGolfTotal.toFixed(2)),
    shuffleboard: parseFloat(shuffleboardTotal.toFixed(2)),
    karaoke: parseFloat(karaokeTotal.toFixed(2)),
    otherEntertainment: parseFloat(otherEntertainmentTotal.toFixed(2)),
    entertainment: parseFloat(entertainmentTotal.toFixed(2)), // Total for backward compatibility
    bookingFee: parseFloat(bookingFeeTotal.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2)),
    lineItems: analysisResult.lineItems || [],
    eventDetails: analysisResult.eventDetails || {},
    preloadedDrinks: analysisResult.preloadedDrinks || null
  };
}

// Upload endpoint - accepts up to 10 PDFs, PNGs, or JPEGs
app.post('/api/upload', upload.array('pdfs', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const results = [];

    // Process each uploaded file (PDF or PNG)
    for (const file of req.files) {
      try {
        console.log(`Analyzing ${file.originalname}...`);
        const analysis = await analyzePartySheet(file.path, file.mimetype);
        const breakdown = processCostBreakdown(analysis);
        
        console.log(`Breakdown for ${file.originalname}:`, {
          food: breakdown.food,
          drinks: breakdown.drinks,
          entertainment: breakdown.entertainment,
          bookingFee: breakdown.bookingFee,
          lineItemsCount: breakdown.lineItems ? breakdown.lineItems.length : 0
        });
        
        results.push({
          filename: file.originalname,
          breakdown: breakdown,
          rawAnalysis: analysis
        });

        // Clean up uploaded file
        await fs.unlink(file.path);
      } catch (error) {
        console.error(`Error processing ${file.originalname}:`, error);
        results.push({
          filename: file.originalname,
          error: error.message
        });
        
        // Clean up file even on error
        try {
          await fs.unlink(file.path);
        } catch (unlinkError) {
          console.error('Error deleting file:', unlinkError);
        }
      }
    }

    // Calculate combined totals across all files
    const combinedTotals = results
      .filter(r => !r.error && r.breakdown)
      .reduce((totals, result) => {
        return {
          food: totals.food + (result.breakdown.food || 0),
          drinks: totals.drinks + (result.breakdown.drinks || 0),
          bowling: totals.bowling + (result.breakdown.bowling || 0),
          darts: totals.darts + (result.breakdown.darts || 0),
          miniGolf: totals.miniGolf + (result.breakdown.miniGolf || 0),
          shuffleboard: totals.shuffleboard + (result.breakdown.shuffleboard || 0),
          karaoke: totals.karaoke + (result.breakdown.karaoke || 0),
          otherEntertainment: totals.otherEntertainment + (result.breakdown.otherEntertainment || 0),
          bookingFee: totals.bookingFee + (result.breakdown.bookingFee || 0),
          grandTotal: totals.grandTotal + (result.breakdown.grandTotal || 0)
        };
      }, { food: 0, drinks: 0, bowling: 0, darts: 0, miniGolf: 0, shuffleboard: 0, karaoke: 0, otherEntertainment: 0, bookingFee: 0, grandTotal: 0 });

    // Calculate total entertainment
    const totalEntertainment = combinedTotals.bowling + combinedTotals.darts + combinedTotals.miniGolf + combinedTotals.shuffleboard + combinedTotals.karaoke + combinedTotals.otherEntertainment;

    res.json({
      success: true,
      results: results,
      combinedTotals: {
        food: parseFloat(combinedTotals.food.toFixed(2)),
        drinks: parseFloat(combinedTotals.drinks.toFixed(2)),
        bowling: parseFloat(combinedTotals.bowling.toFixed(2)),
        darts: parseFloat(combinedTotals.darts.toFixed(2)),
        miniGolf: parseFloat(combinedTotals.miniGolf.toFixed(2)),
        shuffleboard: parseFloat(combinedTotals.shuffleboard.toFixed(2)),
        karaoke: parseFloat(combinedTotals.karaoke.toFixed(2)),
        otherEntertainment: parseFloat(combinedTotals.otherEntertainment.toFixed(2)),
        entertainment: parseFloat(totalEntertainment.toFixed(2)), // Total for reference
        bookingFee: parseFloat(combinedTotals.bookingFee.toFixed(2)),
        grandTotal: parseFloat(combinedTotals.grandTotal.toFixed(2))
      },
      summary: {
        totalFiles: results.length,
        successful: results.filter(r => !r.error).length,
        failed: results.filter(r => r.error).length
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Read Excel file and get first sheet data
async function readExcelFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  
  const data = [];
  worksheet.eachRow((row, rowNumber) => {
    const rowData = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = worksheet.getRow(1).getCell(colNumber).value?.toString() || `Column${colNumber}`;
      rowData[header] = cell.value;
    });
    if (rowNumber > 1) { // Skip header row
      data.push(rowData);
    }
  });
  
  return {
    headers: worksheet.getRow(1).values.slice(1).map(v => v?.toString() || ''),
    data: data
  };
}

// Read and parse CSV file (supports quoted fields)
function detectCsvDelimiter(csvText) {
  // Heuristic: choose the delimiter that appears more in the first non-empty line.
  const firstLine = csvText.split(/\r?\n/).find(l => l && l.trim().length > 0) || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  return semiCount > commaCount ? ';' : ',';
}

function parseCsvRows(csvText, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (char === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        // Escaped quote
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      // Handle CRLF
      if (char === '\r' && csvText[i + 1] === '\n') i++;
      row.push(field);
      field = '';

      // Avoid adding a final empty row
      const isRowEmpty = row.every(c => (c === null || c === undefined || c.toString().trim() === ''));
      if (!isRowEmpty) rows.push(row);

      row = [];
      continue;
    }

    field += char;
  }

  // Flush last field/row
  row.push(field);
  const isRowEmpty = row.every(c => (c === null || c === undefined || c.toString().trim() === ''));
  if (!isRowEmpty) rows.push(row);

  return rows;
}

async function readCsvFile(filePath) {
  let csvText = await fs.readFile(filePath, 'utf8');
  if (csvText.charCodeAt(0) === 0xfeff) {
    csvText = csvText.slice(1);
  } else if (csvText.startsWith('\uFEFF')) {
    csvText = csvText.slice(1);
  }
  const delimiter = detectCsvDelimiter(csvText);
  return parseCsvRows(csvText, delimiter);
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const str = value.toString().trim();
  if (!str) return null;
  const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
  return isNaN(num) ? null : num;
}

// Use OpenAI to identify which columns contain product description, unit price, and date
async function identifyExcelColumns(headers, sampleData) {
  const systemPrompt = `You are an expert at analyzing Excel file structures. Given a list of column headers and sample data, identify which columns contain:
1. Product description/name (the column that identifies what product/item is being sold)
2. Unit price (the column that contains the price per unit)
3. Date (the column that contains the date of the invoice/order)

Return ONLY a valid JSON object with this exact structure:
{
  "productDescriptionColumn": "exact header name or null if not found",
  "unitPriceColumn": "exact header name or null if not found",
  "dateColumn": "exact header name or null if not found"
}`;

  const sampleRows = sampleData.slice(0, 5).map(row => {
    const rowObj = {};
    headers.forEach(header => {
      rowObj[header] = row[header]?.toString() || '';
    });
    return rowObj;
  });

  const userPrompt = `Column headers: ${JSON.stringify(headers)}
Sample data (first 5 rows): ${JSON.stringify(sampleRows, null, 2)}

Identify which columns contain product description, unit price, and date.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      max_tokens: 500
    });

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);
    return result;
  } catch (error) {
    console.error('Error identifying columns:', error);
    // Fallback: try common column names
    const lowerHeaders = headers.map(h => h.toLowerCase());
    return {
      productDescriptionColumn: headers.find((h, i) => 
        lowerHeaders[i].includes('product') || lowerHeaders[i].includes('description') || 
        lowerHeaders[i].includes('item') || lowerHeaders[i].includes('name')
      ) || null,
      unitPriceColumn: headers.find((h, i) => 
        lowerHeaders[i].includes('price') || lowerHeaders[i].includes('unit') ||
        lowerHeaders[i].includes('cost')
      ) || null,
      dateColumn: headers.find((h, i) => 
        lowerHeaders[i].includes('date') || lowerHeaders[i].includes('order')
      ) || null
    };
  }
}

// Extract product data from Excel file
async function extractProductDataFromExcel(filePath, filename) {
  try {
    const excelData = await readExcelFile(filePath);
    const columnMapping = await identifyExcelColumns(excelData.headers, excelData.data);
    
    if (!columnMapping.productDescriptionColumn || !columnMapping.unitPriceColumn) {
      throw new Error(`Could not identify required columns in ${filename}. Found columns: ${excelData.headers.join(', ')}`);
    }

    const extractedData = [];
    excelData.data.forEach(row => {
      const productName = row[columnMapping.productDescriptionColumn]?.toString().trim();
      const priceStr = row[columnMapping.unitPriceColumn]?.toString().trim();
      const dateStr = columnMapping.dateColumn ? row[columnMapping.dateColumn]?.toString().trim() : null;

      if (productName && priceStr) {
        // Parse price (remove currency symbols, commas, etc.)
        const price = parseFloat(priceStr.replace(/[^0-9.-]/g, ''));
        
        // Parse date
        let date = null;
        if (dateStr) {
          const parsedDate = new Date(dateStr);
          if (!isNaN(parsedDate.getTime())) {
            date = parsedDate.toISOString().split('T')[0]; // YYYY-MM-DD format
          }
        }

        if (!isNaN(price) && price > 0) {
          extractedData.push({
            productName: productName,
            unitPrice: price,
            date: date || new Date().toISOString().split('T')[0], // Use today if no date found
            sourceFile: filename,
            rawRow: row
          });
        }
      }
    });

    return extractedData;
  } catch (error) {
    throw new Error(`Error processing Excel file ${filename}: ${error.message}`);
  }
}

// Normalize product name for better matching
function normalizeProductName(name) {
  if (!name) return '';
  
  let normalized = name.toLowerCase().trim();
  
  // Remove common prefixes/suffixes and extra words
  normalized = normalized
    .replace(/^(the|a|an)\s+/i, '') // Remove articles
    .replace(/\s+(the|a|an)$/i, '') // Remove trailing articles
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  return normalized;
}

// Check if two words are similar (handles plurals, common variations)
function wordsSimilar(word1, word2) {
  if (word1 === word2) return true;
  
  // Handle plurals
  const singular1 = word1.replace(/s$/, '');
  const singular2 = word2.replace(/s$/, '');
  if (singular1 === word2 || word1 === singular2 || singular1 === singular2) return true;
  
  // Handle common variations
  const variations = {
    'wing': ['wings'],
    'pretzel': ['pretzels'],
    'bite': ['bites'],
    'tender': ['tenders'],
    'chicken': ['chickens'],
    'beef': ['beefs'],
    'pork': ['porks']
  };
  
  for (const [key, values] of Object.entries(variations)) {
    if ((word1 === key && values.includes(word2)) || (word2 === key && values.includes(word1))) {
      return true;
    }
  }
  
  // Check if one contains the other (for compound words)
  if (word1.length > 3 && word2.length > 3) {
    if (word1.includes(word2) || word2.includes(word1)) return true;
  }
  
  return false;
}

// Calculate similarity score between two product names
function calculateSimilarity(productName, referenceName) {
  const productWords = normalizeProductName(productName).split(/\s+/).filter(w => w.length > 1);
  const refWords = normalizeProductName(referenceName).split(/\s+/).filter(w => w.length > 1);
  
  if (productWords.length === 0 || refWords.length === 0) return 0;
  
  // Exact match
  if (normalizeProductName(productName) === normalizeProductName(referenceName)) {
    return 100;
  }
  
  // Count matching words
  let matches = 0;
  let totalWords = Math.max(productWords.length, refWords.length);
  
  productWords.forEach(pWord => {
    refWords.forEach(rWord => {
      if (wordsSimilar(pWord, rWord)) {
        matches++;
      }
    });
  });
  
  // Calculate score based on word matches
  const wordScore = (matches / totalWords) * 80;
  
  // Check for substring matches (partial match bonus)
  const normalizedProduct = normalizeProductName(productName);
  const normalizedRef = normalizeProductName(referenceName);
  let substringScore = 0;
  if (normalizedProduct.includes(normalizedRef) || normalizedRef.includes(normalizedProduct)) {
    substringScore = 15;
  }
  
  return Math.min(100, wordScore + substringScore);
}

// Fuzzy match product names with improved algorithm
function matchProductName(productName, referenceProducts) {
  if (!productName || !referenceProducts || referenceProducts.length === 0) {
    return null;
  }
  
  const normalized = normalizeProductName(productName);
  
  // Exact match (after normalization)
  const exactMatch = referenceProducts.find(ref => 
    normalizeProductName(ref) === normalized
  );
  if (exactMatch) return exactMatch;

  // Calculate similarity scores for all reference products
  const scores = referenceProducts.map(ref => ({
    product: ref,
    score: calculateSimilarity(productName, ref)
  }));
  
  // Sort by score (highest first)
  scores.sort((a, b) => b.score - a.score);
  
  // Return best match if score is above threshold (30% similarity)
  // Lowered threshold to catch more matches
  if (scores.length > 0 && scores[0].score >= 30) {
    return scores[0].product;
  }

  return null; // No match found
}

/**
 * Map order-guide / CSV line text to a **reference** using:
 * 1) Direct / normalized key in `productMapping` (explicit B/D/E, US, and extra-column aliases)
 * 2) Substring / token match against any `productMapping` key
 * 3) Fuzzy `matchProductName` using `fuzzyReferenceCandidates` (per no–US-foods: only refs whose
 *    primary PFG/Sysco/GFS cell was empty; use full `referenceProducts` for 4-vendor or when list is empty)
 */
function matchProviderToMappingProduct(providerProductName, productMapping, fuzzyReferenceCandidates) {
  if (!providerProductName) return null;
  const n = normalizeProductName(providerProductName);
  if (!n) return null;

  if (productMapping.has(n)) {
    return productMapping.get(n);
  }

  let bestRef = null;
  let bestScore = 0;
  let bestKeyLen = 0;
  for (const [k, ref] of productMapping.entries()) {
    if (k.length < 4) continue;
    let score = 0;
    if (k === n) {
      score = 1;
    } else if (n.includes(k) || k.includes(n)) {
      score = 0.95;
    } else {
      const kTokens = k.split(/\s+/).filter(t => t.length > 1);
      if (kTokens.length < 2) continue;
      let inter = 0;
      for (const t of kTokens) {
        if (n.includes(t) || n.split(/\s+/).indexOf(t) >= 0) inter++;
      }
      score = inter / kTokens.length;
    }
    if (score > bestScore || (score === bestScore && score > 0 && k.length > bestKeyLen)) {
      bestScore = score;
      bestRef = ref;
      bestKeyLen = k.length;
    }
  }
  if (bestScore >= 0.5 && bestRef) {
    return bestRef;
  }

  if (!fuzzyReferenceCandidates || fuzzyReferenceCandidates.length === 0) return null;
  return matchProductName(providerProductName, fuzzyReferenceCandidates);
}

/**
 * GFS order guides: product is often in A or B; your sheet uses **E** for unit price. Infer which
 * column has the long description by looking at rows with a price in E.
 */
function inferGfsOrderGuideLayout(csvRows) {
  const n = Math.min(csvRows.length, 200);
  const colVotes = new Map();
  const priceCol = 4; // E

  for (let r = 0; r < n; r++) {
    const row = csvRows[r] || [];
    const price = parseNumber(row[priceCol]);
    if (price === null || price <= 0) continue;
    let bestC = 0;
    let bestLen = 0;
    for (let c = 0; c < Math.min(row.length, 16); c++) {
      if (c === priceCol) continue;
      const t = (row[c] || '').toString().trim();
      if (t.length < 4) continue;
      if (/^[$]?\s*[\d,]+\.?\d*\s*$/i.test(t)) continue;
      if (t.length > bestLen) {
        bestLen = t.length;
        bestC = c;
      }
    }
    if (bestLen >= 4) {
      colVotes.set(bestC, (colVotes.get(bestC) || 0) + 1);
    }
  }

  let productCol = 1; // B — previous default
  if (colVotes.size > 0) {
    const sorted = [...colVotes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    productCol = sorted[0][0];
  }

  let startIndex0 = 1;
  for (let r = 0; r < n; r++) {
    const row = csvRows[r] || [];
    const pr = (row[productCol] || '').toString().trim();
    const price = parseNumber(row[priceCol]);
    if (pr.length >= 4 && price !== null && price > 0) {
      startIndex0 = r;
      break;
    }
  }

  return { productCol, priceCol, startIndex0 };
}

function inferProviderDataStartIndex(csvRows, productCol, priceCol, defaultStartIndex0) {
  for (let r = 0; r < Math.min(50, csvRows.length); r++) {
    const row = csvRows[r] || [];
    const pr = (row[productCol] || '').toString().trim();
    const price = parseNumber(row[priceCol]);
    if (pr.length >= 3 && price !== null && price > 0) return r;
  }
  return defaultStartIndex0;
}

function parseBiweeklyIntEnv(name, def) {
  const v = (process.env[name] || '').trim();
  if (v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseBiweeklyStartRow1Env(name) {
  const v = (process.env[name] || '').trim();
  if (v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function buildGfsProviderExtractOptions(gfsCsvRows) {
  const inf = inferGfsOrderGuideLayout(gfsCsvRows);
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_GFS_PRODUCT_COL', inf.productCol);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_GFS_PRICE_COL', inf.priceCol);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_GFS_START_ROW');
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : inferProviderDataStartIndex(gfsCsvRows, productCol, priceCol, inf.startIndex0);
  const opt = { vendorName: 'GFS', productCol, priceCol, startRow: startIndex0 + 1 };
  if ((process.env.BIWEEKLY_DEBUG_LAYOUT || '').trim() === '1') {
    console.log('[biweekly] GFS CSV layout (0-based product/price cols):', {
      productCol,
      priceCol,
      dataStartRow1: opt.startRow
    });
  }
  return opt;
}

function buildPfgProviderExtractOptions(pfgCsvRows) {
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_PFG_PRODUCT_COL', 0);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_PFG_PRICE_COL', 7);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_PFG_START_ROW');
  const minDataRow0 = 8; // row 9: known PFG order-guide template
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : Math.max(
          minDataRow0,
          inferProviderDataStartIndex(pfgCsvRows, productCol, priceCol, minDataRow0)
        );
  return { vendorName: 'PFG', productCol, priceCol, startRow: startIndex0 + 1 };
}

function buildSyscoProviderExtractOptions(syscoCsvRows) {
  const productCol = parseBiweeklyIntEnv('BIWEEKLY_SYSCO_PRODUCT_COL', 12);
  const priceCol = parseBiweeklyIntEnv('BIWEEKLY_SYSCO_PRICE_COL', 14);
  const start1 = parseBiweeklyStartRow1Env('BIWEEKLY_SYSCO_START_ROW');
  const minDataRow0 = 2; // row 3: typical header + blank row
  const startIndex0 =
    start1 != null
      ? start1 - 1
      : Math.max(
          minDataRow0,
          inferProviderDataStartIndex(syscoCsvRows, productCol, priceCol, minDataRow0)
        );
  return { vendorName: 'Sysco', productCol, priceCol, startRow: startIndex0 + 1 };
}

/**
 * Map inventory / order-sheet product text (e.g. CSV col B) to a mapping **reference** name (col A) so
 * it matches keys in `providerPriceByVendor` (which are always canonical reference names).
 * Order: exact string → normalized exact → alias in productMapping (same as provider PFG/Sysco/GFS text) → fuzzy matchProductName
 */
function resolveInventoryToReferenceProductName(inventoryName, productMapping, referenceProducts) {
  if (!inventoryName) return null;
  const trimmed = String(inventoryName).trim();
  if (!trimmed) return null;
  if (!referenceProducts || referenceProducts.length === 0) return null;

  for (const ref of referenceProducts) {
    if (ref === trimmed) return ref;
  }
  const nInv = normalizeProductName(trimmed);
  for (const ref of referenceProducts) {
    if (normalizeProductName(ref) === nInv) return ref;
  }
  if (productMapping.has(nInv)) {
    return productMapping.get(nInv);
  }
  return matchProductName(trimmed, referenceProducts);
}

function isUsFoodsMappingHeader(header) {
  const h = String(header || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .trim();
  if (h.includes('us food')) return true;
  if (/(^|\s)usf(\s|$)/.test(h)) return true;
  return false;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// Helper: parse Sysco Excel file (fixed columns: H = product, K = price)
async function extractSyscoDataFromExcel(filePath, filename, manualDate) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];

    const extractedData = [];

    // Assuming row 1 is header, start from row 2
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const productCell = row.getCell(8);  // Column H
      const priceCell = row.getCell(11);   // Column K

      const productName = productCell && productCell.value ? productCell.value.toString().trim() : '';
      const priceStr = priceCell && priceCell.value ? priceCell.value.toString().trim() : '';

      if (!productName || !priceStr) return;

      const price = parseFloat(priceStr.replace(/[^0-9.-]/g, ''));
      if (isNaN(price) || price <= 0) return;

      const date = manualDate || new Date().toISOString().split('T')[0];

      extractedData.push({
        productName,
        unitPrice: price,
        date,
        sourceFile: filename,
        rawRow: {
          H: productCell.value,
          K: priceCell.value
        }
      });
    });

    return extractedData;
  } catch (error) {
    throw new Error(`Error processing Sysco Excel file ${filename}: ${error.message}`);
  }
}

// Helper: parse US Foods Excel file (fixed columns: B = product, G = price)
async function extractUsFoodsDataFromExcel(filePath, filename, manualDate) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];

    const extractedData = [];

    // Assuming row 1 is header, start from row 2
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const productCell = row.getCell(2);  // Column B
      const priceCell = row.getCell(7);   // Column G

      const productName = productCell && productCell.value ? productCell.value.toString().trim() : '';
      const priceStr = priceCell && priceCell.value ? priceCell.value.toString().trim() : '';

      if (!productName || !priceStr) return;

      const price = parseFloat(priceStr.replace(/[^0-9.-]/g, ''));
      if (isNaN(price) || price <= 0) return;

      const date = manualDate || new Date().toISOString().split('T')[0];

      extractedData.push({
        productName,
        unitPrice: price,
        date,
        sourceFile: filename,
        rawRow: {
          B: productCell.value,
          G: priceCell.value
        }
      });
    });

    return extractedData;
  } catch (error) {
    throw new Error(`Error processing US Foods Excel file ${filename}: ${error.message}`);
  }
}

// Biweekly ordering helpers
function mappingCellToString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text || '').join('');
  }
  return v.toString();
}

/**
 * @param {string} mappingFilePath
 * @param {{ includeUsFoodsColumn?: boolean }} [opts]
 */
async function buildProductMappingFromExcelFixedColumns(mappingFilePath, opts = {}) {
  const { includeUsFoodsColumn = true } = opts;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(mappingFilePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return {
      productMapping: new Map(),
      referenceProducts: [],
      refsNoPrimaryPfg: [],
      refsNoPrimarySysco: [],
      refsNoPrimaryGfs: []
    };
  }

  const productMapping = new Map(); // normalized provider product -> reference product
  const referenceProductsSet = new Set();
  const refsNoPrimaryPfg = new Set();
  const refsNoPrimarySysco = new Set();
  const refsNoPrimaryGfs = new Set();

  const setAlias = (aliasRaw, refName) => {
    const alias = (aliasRaw || '').toString().trim();
    if (!alias) return;
    const normalized = normalizeProductName(alias);
    productMapping.set(normalized, refName);
  };

  // Row 1 = headers; data starts at row 2
  const maxCol = Math.min(50, Math.max(5, worksheet.columnCount || 5));
  for (let r = 2; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const refName = mappingCellToString(row.getCell(1).value).trim(); // A
    if (!refName) continue;
    referenceProductsSet.add(refName);

    // Primary vendor columns (1-based, per user sheet layout):
    // A = canonical/reference name (inventory / order sheet naming)
    // B = PFG order-guide product text
    // C = US Foods order-guide product text (skipped when includeUsFoodsColumn is false)
    // D = Sysco order-guide product text
    // E = GFS order-guide product text
    const pfg = mappingCellToString(row.getCell(2).value);
    const usFoods = includeUsFoodsColumn ? mappingCellToString(row.getCell(3).value) : '';
    const sysco = mappingCellToString(row.getCell(4).value);
    const gfs = mappingCellToString(row.getCell(5).value);
    setAlias(pfg, refName);
    if (includeUsFoodsColumn) setAlias(usFoods, refName);
    setAlias(sysco, refName);
    setAlias(gfs, refName);

    // Also treat any other non-empty cells in the row as extra aliases
    // (e.g. alternate spellings in columns beyond E), excluding col A
    for (let c = 2; c <= maxCol; c++) {
      // Column C = US Foods aliases (only for the 4-vendor flow)
      if (c === 3 && !includeUsFoodsColumn) continue;
      if ([2, 3, 4, 5].includes(c)) continue; // already handled (B, C?, D, E)
      const t = mappingCellToString(row.getCell(c).value).trim();
      if (!t) continue;
      setAlias(t, refName);
    }
  }

  return {
    productMapping,
    referenceProducts: Array.from(referenceProductsSet),
    refsNoPrimaryPfg: Array.from(refsNoPrimaryPfg),
    refsNoPrimarySysco: Array.from(refsNoPrimarySysco),
    refsNoPrimaryGfs: Array.from(refsNoPrimaryGfs)
  };
}

/**
 * @param {string} mappingFilePath
 * @param {{ includeUsFoodsColumn?: boolean }} [opts]
 */
async function buildProductMappingFromExcel(mappingFilePath, opts = {}) {
  const mode = (process.env.BIWEEKLY_MAPPING_LAYOUT || 'fixed').toLowerCase();
  if (mode === 'auto' || mode === 'legacy' || mode === 'heuristic') {
    return buildProductMappingFromExcelHeuristicHeaders(mappingFilePath, opts);
  }
  if (mode === 'fixed') {
    return buildProductMappingFromExcelFixedColumns(mappingFilePath, opts);
  }
  throw new Error(`Invalid BIWEEKLY_MAPPING_LAYOUT="${process.env.BIWEEKLY_MAPPING_LAYOUT}" (use fixed|auto)`);
}

// Legacy mapping: infer reference column from header name; treat remaining columns as provider aliases
async function buildProductMappingFromExcelHeuristicHeaders(mappingFilePath, opts = {}) {
  const { includeUsFoodsColumn = true } = opts;
  const mappingData = await readExcelFile(mappingFilePath);

  // New structure: First column is reference product name (or a column containing "reference"/"target"/etc)
  let referenceColumnIndex = 0;
  let referenceColumn = mappingData.headers[0];

  mappingData.headers.forEach((header, index) => {
    const lowerHeader = header.toLowerCase();
    if (
      lowerHeader.includes('reference') ||
      lowerHeader.includes('target') ||
      lowerHeader.includes('match') ||
      lowerHeader.includes('standard')
    ) {
      referenceColumnIndex = index;
      referenceColumn = header;
    }
  });

  const invoiceColumns = mappingData.headers.filter((_, index) => index !== referenceColumnIndex);
  const productMapping = new Map(); // normalized provider product -> reference product
  const referenceProductsSet = new Set();

  mappingData.data.forEach(row => {
    const refName = row[referenceColumn]?.toString().trim();
    if (!refName) return;
    referenceProductsSet.add(refName);

    invoiceColumns.forEach(invoiceColumn => {
      if (!includeUsFoodsColumn && isUsFoodsMappingHeader(String(invoiceColumn || ''))) {
        return;
      }
      const invoiceName = row[invoiceColumn]?.toString().trim();
      if (invoiceName) {
        const normalizedInvoice = normalizeProductName(invoiceName);
        productMapping.set(normalizedInvoice, refName);
      }
    });
  });

  const referenceProducts = Array.from(referenceProductsSet);
  return {
    productMapping,
    referenceProducts,
    // Heuristic layout has no fixed B/D/E columns; fuzzy against all references (same as 4-vendor).
    refsNoPrimaryPfg: referenceProducts,
    refsNoPrimarySysco: referenceProducts,
    refsNoPrimaryGfs: referenceProducts
  };
}

function upsertMin(map, key, value) {
  if (!map.has(key)) {
    map.set(key, value);
    return;
  }
  const existing = map.get(key);
  if (value < existing) map.set(key, value);
}

function upsertMax(map, key, value) {
  if (!map.has(key)) {
    map.set(key, value);
    return;
  }
  const existing = map.get(key);
  if (value > existing) map.set(key, value);
}

function extractInventoryQuantitiesFromCsvRows(csvRows) {
  // Inventory CSV: product in column B (index 1), quantity in column K (index 10), data starts on row 2 (index 1).
  const quantities = new Map();
  for (let r = 1; r < csvRows.length; r++) {
    const row = csvRows[r] || [];
    const productName = (row[1] || '').toString().trim(); // Column B
    const qtyNum = parseNumber(row[10]); // Column K

    if (!productName || qtyNum === null) continue;
    if (qtyNum <= 0) continue;

    // Inventory sheet may have duplicate products; sum them.
    const existing = quantities.get(productName) || 0;
    quantities.set(productName, existing + qtyNum);
  }
  return quantities;
}

function extractProviderPricesFromCsvRows(csvRows, productMapping, referenceProducts) {
  const vendorDefinitions = [
    { name: 'US Foods', productCol: 3, priceCol: 7 }, // D/H
    { name: 'PFG', productCol: 0, priceCol: 7 }, // A/H
    { name: 'Sysco', productCol: 12, priceCol: 14 }, // M/O
    { name: 'GFS', productCol: 1, priceCol: 4 } // B/E
  ];

  const providerPriceByVendor = {};
  vendorDefinitions.forEach(v => {
    providerPriceByVendor[v.name] = new Map(); // canonical product -> min unit price
  });

  const matchedRecords = {
    mapped: 0,
    fuzzyMatched: 0,
    unmatched: 0
  };

  csvRows.forEach(row => {
    vendorDefinitions.forEach(v => {
      const providerProductName = (row[v.productCol] || '').toString().trim();
      const unitPrice = parseNumber(row[v.priceCol]);
      if (!providerProductName || unitPrice === null || unitPrice <= 0) return;

      const normalizedProviderProduct = normalizeProductName(providerProductName);
      const mappedProduct = matchProviderToMappingProduct(
        providerProductName,
        productMapping,
        referenceProducts
      );

      if (mappedProduct) {
        if (productMapping.has(normalizedProviderProduct)) {
          matchedRecords.mapped++;
        } else {
          matchedRecords.fuzzyMatched++;
        }

        upsertMin(providerPriceByVendor[v.name], mappedProduct, unitPrice);
      } else {
        matchedRecords.unmatched++;
      }
    });
  });

  return {
    providerPriceByVendor,
    matchedRecords
  };
}

function extractProviderPricesFromSingleCsvRows(csvRows, options, productMapping, fuzzyReferenceCandidates) {
  const {
    vendorName,
    productCol,
    priceCol,
    startRow // 1-based row number in the CSV file where data begins
  } = options;

  const providerPriceByVendor = {};
  providerPriceByVendor[vendorName] = new Map(); // canonical product -> chosen unit price (case/4-pack => max)

  // Track how many source rows mapped to a canonical product for this vendor.
  // If >1, we can show a note in the UI that case/4-pack pricing was used.
  const matchedRowCountsByProduct = new Map(); // canonical product -> count

  const matchedRecords = {
    mapped: 0,
    fuzzyMatched: 0,
    unmatched: 0
  };

  // Convert 1-based startRow to 0-based index.
  const startIndex = Math.max(0, startRow - 1);

  for (let r = startIndex; r < csvRows.length; r++) {
    const row = csvRows[r] || [];
    const providerProductName = (row[productCol] || '').toString().trim();
    const unitPrice = parseNumber(row[priceCol]);

    if (!providerProductName || unitPrice === null || unitPrice <= 0) continue;

    const normalizedProviderProduct = normalizeProductName(providerProductName);
    const mappedProduct = matchProviderToMappingProduct(
      providerProductName,
      productMapping,
      fuzzyReferenceCandidates
    );

    if (mappedProduct) {
      if (productMapping.has(normalizedProviderProduct)) {
        matchedRecords.mapped++;
      } else {
        matchedRecords.fuzzyMatched++;
      }

      matchedRowCountsByProduct.set(mappedProduct, (matchedRowCountsByProduct.get(mappedProduct) || 0) + 1);

      // Pack-size rule: if multiple rows map to same canonical product at this vendor,
      // keep the MORE EXPENSIVE unit price (case/4-pack) rather than the cheapest.
      upsertMax(providerPriceByVendor[vendorName], mappedProduct, unitPrice);
    } else {
      matchedRecords.unmatched++;
    }
  }

  return {
    providerPriceByVendor,
    matchedRecords,
    matchedRowCountsByProduct
  };
}

// Biweekly order recommendation endpoint
app.post('/api/biweekly-order', biweeklyUpload.fields([
  { name: 'inventoryCsv', maxCount: 1 },
  { name: 'usFoodsCsv', maxCount: 1 },
  { name: 'pfgCsv', maxCount: 1 },
  { name: 'syscoCsv', maxCount: 1 },
  { name: 'gfsCsv', maxCount: 1 },
  { name: 'mappingSheet', maxCount: 1 }
]), async (req, res) => {
  const inventoryFile = req.files?.inventoryCsv?.[0] || null;
  const usFoodsFile = req.files?.usFoodsCsv?.[0] || null;
  const pfgFile = req.files?.pfgCsv?.[0] || null;
  const syscoFile = req.files?.syscoCsv?.[0] || null;
  const gfsFile = req.files?.gfsCsv?.[0] || null;
  const mappingFile = req.files?.mappingSheet?.[0] || null;

  try {
    if (!inventoryFile || !usFoodsFile || !pfgFile || !syscoFile || !gfsFile || !mappingFile) {
      return res.status(400).json({ error: 'Please upload inventoryCsv, usFoodsCsv, pfgCsv, syscoCsv, gfsCsv, and mappingSheet' });
    }

    const [inventoryCsvRows, usFoodsCsvRows, pfgCsvRows, syscoCsvRows, gfsCsvRows] = await Promise.all([
      readCsvFile(inventoryFile.path),
      readCsvFile(usFoodsFile.path),
      readCsvFile(pfgFile.path),
      readCsvFile(syscoFile.path),
      readCsvFile(gfsFile.path)
    ]);

    const { productMapping, referenceProducts } = await buildProductMappingFromExcel(mappingFile.path);

    const inventoryQuantities = extractInventoryQuantitiesFromCsvRows(inventoryCsvRows);

    const [
      usFoodsResult,
      pfgResult,
      syscoResult,
      gfsResult
    ] = [
      extractProviderPricesFromSingleCsvRows(usFoodsCsvRows, { vendorName: 'US Foods', productCol: 3, priceCol: 7, startRow: 2 }, productMapping, referenceProducts),
      extractProviderPricesFromSingleCsvRows(pfgCsvRows, buildPfgProviderExtractOptions(pfgCsvRows), productMapping, referenceProducts),
      extractProviderPricesFromSingleCsvRows(syscoCsvRows, buildSyscoProviderExtractOptions(syscoCsvRows), productMapping, referenceProducts),
      extractProviderPricesFromSingleCsvRows(gfsCsvRows, buildGfsProviderExtractOptions(gfsCsvRows), productMapping, referenceProducts)
    ];

    const providerPriceByVendor = {
      'US Foods': usFoodsResult.providerPriceByVendor['US Foods'],
      PFG: pfgResult.providerPriceByVendor['PFG'],
      Sysco: syscoResult.providerPriceByVendor['Sysco'],
      GFS: gfsResult.providerPriceByVendor['GFS']
    };

    const multiPackByVendor = {
      'US Foods': usFoodsResult.matchedRowCountsByProduct,
      PFG: pfgResult.matchedRowCountsByProduct,
      Sysco: syscoResult.matchedRowCountsByProduct,
      GFS: gfsResult.matchedRowCountsByProduct
    };

    const matchedRecords = {
      mapped: usFoodsResult.matchedRecords.mapped + pfgResult.matchedRecords.mapped + syscoResult.matchedRecords.mapped + gfsResult.matchedRecords.mapped,
      fuzzyMatched: usFoodsResult.matchedRecords.fuzzyMatched + pfgResult.matchedRecords.fuzzyMatched + syscoResult.matchedRecords.fuzzyMatched + gfsResult.matchedRecords.fuzzyMatched,
      unmatched: usFoodsResult.matchedRecords.unmatched + pfgResult.matchedRecords.unmatched + syscoResult.matchedRecords.unmatched + gfsResult.matchedRecords.unmatched
    };

    const vendorTotals = {
      'US Foods': 0,
      PFG: 0,
      Sysco: 0,
      GFS: 0
    };

    const recommendations = [];
    const unmatchedItems = [];

    for (const [inventoryLabel, quantity] of inventoryQuantities.entries()) {
      const canonical = resolveInventoryToReferenceProductName(inventoryLabel, productMapping, referenceProducts);
      if (!canonical) {
        unmatchedItems.push({ productName: inventoryLabel, quantity, reason: 'inventory_not_in_mapping' });
        continue;
      }

      let best = null; // { vendor, unitPrice }

      for (const vendor of Object.keys(providerPriceByVendor)) {
        const unitPrice = providerPriceByVendor[vendor].get(canonical);
        if (unitPrice === undefined) continue;
        if (!best || unitPrice < best.unitPrice) {
          best = { vendor, unitPrice };
        }
      }

      if (!best) {
        unmatchedItems.push({
          productName: inventoryLabel,
          quantity,
          referenceProduct: canonical,
          reason: 'no_price_for_reference'
        });
        continue;
      }

      const lineTotal = quantity * best.unitPrice;
      vendorTotals[best.vendor] += lineTotal;

      const vendorCounts = multiPackByVendor[best.vendor];
      const mappedRowCount = vendorCounts ? (vendorCounts.get(canonical) || 0) : 0;
      const packNote = mappedRowCount > 1 ? 'Case/4-pack price used (multiple pack options found)' : null;

      recommendations.push({
        productName: inventoryLabel,
        referenceProduct: canonical,
        quantity,
        vendor: best.vendor,
        unitPrice: best.unitPrice,
        lineTotal,
        packNote
      });
    }

    const grandTotal = Object.values(vendorTotals).reduce((sum, v) => sum + v, 0);

    res.json({
      success: true,
      summary: {
        recommendationsCount: recommendations.length,
        unmatchedCount: unmatchedItems.length,
        grandTotal: parseFloat(grandTotal.toFixed(2)),
        vendorTotals
      },
      matchedRecords,
      recommendations,
      unmatchedItems
    });
  } catch (error) {
    console.error('Biweekly order processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Cleanup uploaded files
    for (const f of [inventoryFile, usFoodsFile, pfgFile, syscoFile, gfsFile, mappingFile]) {
      if (f && f.path) {
        try {
          await fs.unlink(f.path);
        } catch (unlinkError) {
          console.error('Error deleting uploaded file:', unlinkError);
        }
      }
    }
  }
});

// Biweekly order recommendation endpoint (no US Foods) — supports Google Sheets fallback for inventory + mapping.
app.post(
  '/api/biweekly-order-no-usfoods',
  biweeklyUpload.fields([
    { name: 'inventoryCsv', maxCount: 1 },
    { name: 'pfgCsv', maxCount: 1 },
    { name: 'syscoCsv', maxCount: 1 },
    { name: 'gfsCsv', maxCount: 1 },
    { name: 'mappingSheet', maxCount: 1 }
  ]),
  async (req, res) => {
    const inventoryFile = req.files?.inventoryCsv?.[0] || null;
    const pfgFile = req.files?.pfgCsv?.[0] || null;
    const syscoFile = req.files?.syscoCsv?.[0] || null;
    const gfsFile = req.files?.gfsCsv?.[0] || null;
    const mappingFile = req.files?.mappingSheet?.[0] || null;

    const invUrl = (process.env.BIWEEKLY_INVENTORY_SHEET_URL || '').trim();
    const mapUrl = (process.env.BIWEEKLY_MAPPING_SHEET_URL || '').trim();

    const tmpRoot = path.join(os.tmpdir(), 'onpar-biweekly');
    const tmpId = crypto.randomBytes(8).toString('hex');
    const tmpDir = path.join(tmpRoot, tmpId);

    try {
      if (!pfgFile || !syscoFile || !gfsFile) {
        return res.status(400).json({ error: 'Please upload pfgCsv, syscoCsv, and gfsCsv' });
      }

      // Inventory + mapping can come from uploads OR from Google Sheets export URLs.
      let inventoryPath = inventoryFile?.path || null;
      let mappingPath = mappingFile?.path || null;

      if (!inventoryPath) {
        if (!invUrl) return res.status(400).json({ error: 'Missing inventoryCsv (or set BIWEEKLY_INVENTORY_SHEET_URL)' });
        await fs.mkdir(tmpDir, { recursive: true });
        inventoryPath = path.join(tmpDir, 'inventory.csv');
        await downloadUrlToFile(invUrl, inventoryPath, { expectExt: '.csv', expectContentTypes: ['text/csv', 'application/csv'] });
      }

      if (!mappingPath) {
        if (!mapUrl) return res.status(400).json({ error: 'Missing mappingSheet (or set BIWEEKLY_MAPPING_SHEET_URL)' });
        await fs.mkdir(tmpDir, { recursive: true });
        mappingPath = path.join(tmpDir, 'mapping.xlsx');
        await downloadUrlToFile(mapUrl, mappingPath, {
          expectExt: '.xlsx',
          expectContentTypes: [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/octet-stream'
          ]
        });
      }

      const [inventoryCsvRows, pfgCsvRows, syscoCsvRows, gfsCsvRows] = await Promise.all([
        readCsvFile(inventoryPath),
        readCsvFile(pfgFile.path),
        readCsvFile(syscoFile.path),
        readCsvFile(gfsFile.path)
      ]);

      const {
        productMapping,
        referenceProducts,
        refsNoPrimaryPfg,
        refsNoPrimarySysco,
        refsNoPrimaryGfs
      } = await buildProductMappingFromExcel(mappingPath, { includeUsFoodsColumn: false });
      const inventoryQuantities = extractInventoryQuantitiesFromCsvRows(inventoryCsvRows);

      // No–US-foods: fuzzy fallback only against references whose primary PFG/Sysco/GFS cell (B/D/E) was empty;
      // if every row had a primary for that vendor, fall back to all references (same as 4-vendor).
      const fuzzyPfg = refsNoPrimaryPfg.length > 0 ? refsNoPrimaryPfg : referenceProducts;
      const fuzzySysco = refsNoPrimarySysco.length > 0 ? refsNoPrimarySysco : referenceProducts;
      const fuzzyGfs = refsNoPrimaryGfs.length > 0 ? refsNoPrimaryGfs : referenceProducts;

      const [pfgResult, syscoResult, gfsResult] = [
        extractProviderPricesFromSingleCsvRows(pfgCsvRows, buildPfgProviderExtractOptions(pfgCsvRows), productMapping, fuzzyPfg),
        extractProviderPricesFromSingleCsvRows(syscoCsvRows, buildSyscoProviderExtractOptions(syscoCsvRows), productMapping, fuzzySysco),
        extractProviderPricesFromSingleCsvRows(gfsCsvRows, buildGfsProviderExtractOptions(gfsCsvRows), productMapping, fuzzyGfs)
      ];

      const providerPriceByVendor = {
        PFG: pfgResult.providerPriceByVendor['PFG'],
        Sysco: syscoResult.providerPriceByVendor['Sysco'],
        GFS: gfsResult.providerPriceByVendor['GFS']
      };

      const multiPackByVendor = {
        PFG: pfgResult.matchedRowCountsByProduct,
        Sysco: syscoResult.matchedRowCountsByProduct,
        GFS: gfsResult.matchedRowCountsByProduct
      };

      const matchedRecords = {
        mapped: pfgResult.matchedRecords.mapped + syscoResult.matchedRecords.mapped + gfsResult.matchedRecords.mapped,
        fuzzyMatched: pfgResult.matchedRecords.fuzzyMatched + syscoResult.matchedRecords.fuzzyMatched + gfsResult.matchedRecords.fuzzyMatched,
        unmatched: pfgResult.matchedRecords.unmatched + syscoResult.matchedRecords.unmatched + gfsResult.matchedRecords.unmatched
      };

      const vendorTotals = { PFG: 0, Sysco: 0, GFS: 0 };
      const recommendations = [];
      const unmatchedItems = [];

      for (const [inventoryLabel, quantity] of inventoryQuantities.entries()) {
        const canonical = resolveInventoryToReferenceProductName(inventoryLabel, productMapping, referenceProducts);
        if (!canonical) {
          unmatchedItems.push({ productName: inventoryLabel, quantity, reason: 'inventory_not_in_mapping' });
          continue;
        }

        let best = null;
        for (const vendor of Object.keys(providerPriceByVendor)) {
          const unitPrice = providerPriceByVendor[vendor].get(canonical);
          if (unitPrice === undefined) continue;
          if (!best || unitPrice < best.unitPrice) best = { vendor, unitPrice };
        }
        if (!best) {
          unmatchedItems.push({
            productName: inventoryLabel,
            quantity,
            referenceProduct: canonical,
            reason: 'no_price_for_reference'
          });
          continue;
        }

        const lineTotal = quantity * best.unitPrice;
        vendorTotals[best.vendor] += lineTotal;

        const vendorCounts = multiPackByVendor[best.vendor];
        const mappedRowCount = vendorCounts ? (vendorCounts.get(canonical) || 0) : 0;
        const packNote = mappedRowCount > 1 ? 'Case/4-pack price used (multiple pack options found)' : null;

        recommendations.push({
          productName: inventoryLabel,
          referenceProduct: canonical,
          quantity,
          vendor: best.vendor,
          unitPrice: best.unitPrice,
          lineTotal,
          packNote
        });
      }

      const grandTotal = Object.values(vendorTotals).reduce((sum, v) => sum + v, 0);

      res.json({
        success: true,
        summary: {
          recommendationsCount: recommendations.length,
          unmatchedCount: unmatchedItems.length,
          grandTotal: parseFloat(grandTotal.toFixed(2)),
          vendorTotals
        },
        matchedRecords,
        recommendations,
        unmatchedItems
      });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Server error' });
    } finally {
      // best-effort cleanup
      try {
        if (tmpDir.startsWith(tmpRoot) && fssync.existsSync(tmpDir)) {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
);

// Vendor Cost Management endpoint
app.post('/api/vendor-costs', excelUpload.fields([
  { name: 'referenceSheet', maxCount: 1 },
  { name: 'mappingSheet', maxCount: 1 },
  { name: 'vendorFiles', maxCount: 50 },
  { name: 'syscoFiles', maxCount: 50 },
  { name: 'usFoodsFiles', maxCount: 50 }
]), async (req, res) => {
  try {
    if (!req.files || !req.files.referenceSheet || !req.files.vendorFiles || req.files.vendorFiles.length === 0) {
      return res.status(400).json({ error: 'Please upload both a reference sheet and at least one vendor file' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const referenceFile = req.files.referenceSheet[0];
    const mappingFile = req.files.mappingSheet && req.files.mappingSheet[0] ? req.files.mappingSheet[0] : null;
    const vendorFiles = Array.isArray(req.files.vendorFiles) ? req.files.vendorFiles : [req.files.vendorFiles];

    // Sysco-specific files with manual dates
    const syscoFiles = req.files.syscoFiles
      ? (Array.isArray(req.files.syscoFiles) ? req.files.syscoFiles : [req.files.syscoFiles])
      : [];

    // Multer parses non-file fields into req.body; syscoDates may be a string or array
    let syscoDates = [];
    if (req.body && req.body.syscoDates) {
      if (Array.isArray(req.body.syscoDates)) {
        syscoDates = req.body.syscoDates;
      } else {
        syscoDates = [req.body.syscoDates];
      }
    }

    // US Foods-specific files with manual dates
    const usFoodsFiles = req.files.usFoodsFiles
      ? (Array.isArray(req.files.usFoodsFiles) ? req.files.usFoodsFiles : [req.files.usFoodsFiles])
      : [];

    // Multer parses non-file fields into req.body; usFoodsDates may be a string or array
    let usFoodsDates = [];
    if (req.body && req.body.usFoodsDates) {
      if (Array.isArray(req.body.usFoodsDates)) {
        usFoodsDates = req.body.usFoodsDates;
      } else {
        usFoodsDates = [req.body.usFoodsDates];
      }
    }

    // Extract reference products from reference sheet
    console.log('Processing reference sheet...');
    const referenceData = await readExcelFile(referenceFile.path);
    const referenceColumnMapping = await identifyExcelColumns(referenceData.headers, referenceData.data);
    
    if (!referenceColumnMapping.productDescriptionColumn) {
      await fs.unlink(referenceFile.path);
      if (mappingFile) await fs.unlink(mappingFile.path);
      return res.status(400).json({ error: 'Could not identify product description column in reference sheet' });
    }

    const referenceProducts = [];
    referenceData.data.forEach(row => {
      const productName = row[referenceColumnMapping.productDescriptionColumn]?.toString().trim();
      if (productName) {
        referenceProducts.push(productName);
      }
    });

    console.log(`Found ${referenceProducts.length} reference products`);

    // Process mapping sheet if provided
    const productMapping = new Map(); // Maps invoice product name -> reference product name
    if (mappingFile) {
      console.log('Processing mapping sheet...');
      try {
        const mappingData = await readExcelFile(mappingFile.path);
        
        // New structure: First column is reference product name, remaining columns are invoice variations
        // Look for a column that contains "reference" in the name, otherwise assume first column
        let referenceColumnIndex = 0;
        let referenceColumn = mappingData.headers[0];
        
        mappingData.headers.forEach((header, index) => {
          const lowerHeader = header.toLowerCase();
          if (lowerHeader.includes('reference') || lowerHeader.includes('target') || 
              lowerHeader.includes('match') || lowerHeader.includes('standard')) {
            referenceColumnIndex = index;
            referenceColumn = header;
          }
        });
        
        console.log(`Using "${referenceColumn}" as reference product column`);
        
        // All other columns are invoice product name variations
        const invoiceColumns = mappingData.headers.filter((header, index) => index !== referenceColumnIndex);
        console.log(`Found ${invoiceColumns.length} invoice description columns: ${invoiceColumns.join(', ')}`);
        
        mappingData.data.forEach((row, rowIndex) => {
          const refName = row[referenceColumn]?.toString().trim();
          if (!refName) return; // Skip rows without reference product name
          
          // Map all invoice variations in this row to the reference product
          invoiceColumns.forEach(invoiceColumn => {
            const invoiceName = row[invoiceColumn]?.toString().trim();
            if (invoiceName) {
              const normalizedInvoice = normalizeProductName(invoiceName);
              productMapping.set(normalizedInvoice, refName); // Store normalized invoice -> reference
              console.log(`  Mapping: "${invoiceName}" -> "${refName}"`);
            }
          });
        });
        
        console.log(`Created ${productMapping.size} product mappings from mapping sheet`);
        
        await fs.unlink(mappingFile.path);
      } catch (error) {
        console.error('Error processing mapping sheet:', error);
        // Continue without mapping sheet
      }
    }

    // Extract data from all vendor files
    const allExtractedData = [];
    for (const vendorFile of vendorFiles) {
      try {
        console.log(`Processing vendor file: ${vendorFile.originalname}...`);
        const extracted = await extractProductDataFromExcel(vendorFile.path, vendorFile.originalname);
        allExtractedData.push(...extracted);
        await fs.unlink(vendorFile.path);
      } catch (error) {
        console.error(`Error processing ${vendorFile.originalname}:`, error);
        try {
          await fs.unlink(vendorFile.path);
        } catch (unlinkError) {
          console.error('Error deleting file:', unlinkError);
        }
      }
    }

    // Extract data from Sysco files using manual dates (Column H = product, Column K = price)
    if (syscoFiles.length > 0) {
      console.log(`Processing ${syscoFiles.length} Sysco file(s) with manual dates...`);
      for (let i = 0; i < syscoFiles.length; i++) {
        const syscoFile = syscoFiles[i];
        const manualDate = syscoDates[i] || new Date().toISOString().split('T')[0];
        try {
          console.log(`Processing Sysco file: ${syscoFile.originalname} with date ${manualDate}...`);
          const extractedSysco = await extractSyscoDataFromExcel(syscoFile.path, syscoFile.originalname, manualDate);
          allExtractedData.push(...extractedSysco);
          await fs.unlink(syscoFile.path);
        } catch (error) {
          console.error(`Error processing Sysco file ${syscoFile.originalname}:`, error);
          try {
            await fs.unlink(syscoFile.path);
          } catch (unlinkError) {
            console.error('Error deleting Sysco file:', unlinkError);
          }
        }
      }
    }

    // Extract data from US Foods files using manual dates (Column B = product, Column G = price)
    if (usFoodsFiles.length > 0) {
      console.log(`Processing ${usFoodsFiles.length} US Foods file(s) with manual dates...`);
      for (let i = 0; i < usFoodsFiles.length; i++) {
        const usFoodsFile = usFoodsFiles[i];
        const manualDate = usFoodsDates[i] || new Date().toISOString().split('T')[0];
        try {
          console.log(`Processing US Foods file: ${usFoodsFile.originalname} with date ${manualDate}...`);
          const extractedUsFoods = await extractUsFoodsDataFromExcel(
            usFoodsFile.path,
            usFoodsFile.originalname,
            manualDate
          );
          allExtractedData.push(...extractedUsFoods);
          await fs.unlink(usFoodsFile.path);
        } catch (error) {
          console.error(`Error processing US Foods file ${usFoodsFile.originalname}:`, error);
          try {
            await fs.unlink(usFoodsFile.path);
          } catch (unlinkError) {
            console.error('Error deleting US Foods file:', unlinkError);
          }
        }
      }
    }

    // Clean up reference file
    await fs.unlink(referenceFile.path);

    // Match extracted products to reference products and organize by product
    const productsMap = new Map();
    const unmatchedItems = [];
    const matchStats = {
      matched: 0,
      unmatched: 0,
      mapped: 0,
      fuzzyMatched: 0
    };

    allExtractedData.forEach(item => {
      let matchedProduct = null;
      const normalizedInvoiceName = normalizeProductName(item.productName);
      
      // First, check mapping sheet (exact mappings take priority)
      if (productMapping.has(normalizedInvoiceName)) {
        matchedProduct = productMapping.get(normalizedInvoiceName);
        matchStats.mapped++;
        console.log(`✓ Mapped: "${item.productName}" -> "${matchedProduct}"`);
      } else {
        // Fall back to fuzzy matching
        matchedProduct = matchProductName(item.productName, referenceProducts);
        if (matchedProduct) {
          matchStats.fuzzyMatched++;
        }
      }
      
      if (matchedProduct) {
        if (!productsMap.has(matchedProduct)) {
          productsMap.set(matchedProduct, []);
        }
        productsMap.get(matchedProduct).push({
          date: item.date,
          price: item.unitPrice,
          sourceFile: item.sourceFile
        });
        matchStats.matched++;
      } else {
        unmatchedItems.push({
          productName: item.productName,
          price: item.unitPrice,
          date: item.date,
          sourceFile: item.sourceFile
        });
        matchStats.unmatched++;
        console.log(`⚠️  No match found for: "${item.productName}" (from ${item.sourceFile})`);
      }
    });

    console.log(`\n📊 Matching Statistics:`);
    console.log(`   Total Matched: ${matchStats.matched}`);
    console.log(`   - From Mapping Sheet: ${matchStats.mapped}`);
    console.log(`   - From Fuzzy Matching: ${matchStats.fuzzyMatched}`);
    console.log(`   Unmatched: ${matchStats.unmatched}`);
    if (unmatchedItems.length > 0) {
      console.log(`\n❌ Unmatched items (${unmatchedItems.length}):`);
      const uniqueUnmatched = [...new Set(unmatchedItems.map(item => item.productName))];
      uniqueUnmatched.forEach(name => {
        console.log(`   - "${name}"`);
      });
    }

    // Convert to array format and calculate averages
    const products = Array.from(productsMap.entries()).map(([productName, priceHistory]) => {
      // Sort by date
      priceHistory.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      // Calculate average
      const averagePrice = priceHistory.reduce((sum, item) => sum + item.price, 0) / priceHistory.length;
      
      // Get most recent price (last item after sorting)
      const mostRecentPrice = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : null;
      
      // Calculate percentage change from average to most recent
      let percentChange = null;
      if (mostRecentPrice && averagePrice > 0) {
        percentChange = ((mostRecentPrice - averagePrice) / averagePrice) * 100;
      }

      return {
        productName: productName,
        priceHistory: priceHistory,
        averagePrice: parseFloat(averagePrice.toFixed(2)),
        mostRecentPrice: mostRecentPrice ? parseFloat(mostRecentPrice.toFixed(2)) : null,
        percentChange: percentChange !== null ? parseFloat(percentChange.toFixed(2)) : null
      };
    });

    // Sort products by name
    products.sort((a, b) => a.productName.localeCompare(b.productName));

    res.json({
      success: true,
      products: products,
      unmatchedItems: unmatchedItems.slice(0, 50), // Limit to first 50 for response size
      summary: {
        referenceProductsCount: referenceProducts.length,
        matchedProductsCount: products.length,
        totalDataPoints: allExtractedData.length,
        matchedDataPoints: matchStats.matched,
        unmatchedDataPoints: matchStats.unmatched,
        mappedFromSheet: matchStats.mapped,
        fuzzyMatched: matchStats.fuzzyMatched
      }
    });
  } catch (error) {
    console.error('Vendor cost processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all handler: serve index.html for any non-API routes
// This ensures the SPA works correctly on Vercel
// Use a function to handle all non-API GET requests
app.use((req, res, next) => {
  // Don't handle API routes or static files that exist
  if (req.path.startsWith('/api/')) {
    return next();
  }
  
  // For GET requests to non-API routes, serve index.html
  if (req.method === 'GET') {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('Error sending index.html:', err);
        res.status(500).send('Error loading page');
      }
    });
  } else {
    next();
  }
});

// Export for Vercel serverless functions
// Export as a handler function for better Vercel compatibility
module.exports = app;

// Only listen if running locally (not on Vercel)
// Vercel doesn't call app.listen(), it uses serverless functions
if (!process.env.VERCEL && !process.env.NOW) {
  const port = process.env.PORT || PORT;
  app.listen(port, () => {
    console.log(`🚀 Food Portal running on http://localhost:${port}`);
    console.log(`📝 OpenAI API configured: ${!!process.env.OPENAI_API_KEY}`);
  });
}

