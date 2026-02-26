const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');
const ExcelJS = require('exceljs');
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// Vendor Cost Management endpoint
app.post('/api/vendor-costs', excelUpload.fields([
  { name: 'referenceSheet', maxCount: 1 },
  { name: 'mappingSheet', maxCount: 1 },
  { name: 'vendorFiles', maxCount: 50 }
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

