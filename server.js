const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');
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
    if (file.mimetype === 'application/pdf' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and PNG files are allowed'));
    }
  }
});

// Serve static files
app.use(express.static('public'));

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
          3. ENTERTAINMENT - bowling, darts, duckpin bowling, karaoke, shuffleboard, mini golf, and similar activities
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
                "category": "FOOD" | "DRINKS" | "ENTERTAINMENT" | "BOOKING_FEE",
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
    } else if (mimeType === 'image/png') {
      // Handle PNG: use Vision API
      const base64Image = await imageToBase64(filePath);
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
                url: `data:image/png;base64,${base64Image}`
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
  let entertainmentTotal = 0;
  let bookingFeeTotal = 0;

  // Process line items
  if (analysisResult.lineItems && Array.isArray(analysisResult.lineItems)) {
    analysisResult.lineItems.forEach(item => {
      const amount = item.total || 0;
      
      if (item.category === 'FOOD') {
        foodTotal += amount;
      } else if (item.category === 'DRINKS') {
        drinksTotal += amount;
      } else if (item.category === 'ENTERTAINMENT') {
        entertainmentTotal += amount;
      } else if (item.category === 'BOOKING_FEE') {
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

  // Also check if totals are provided directly
  if (analysisResult.totals) {
    if (analysisResult.totals.food !== undefined) {
      foodTotal = analysisResult.totals.food;
    }
    if (analysisResult.totals.drinks !== undefined) {
      drinksTotal = analysisResult.totals.drinks;
    }
    if (analysisResult.totals.entertainment !== undefined) {
      entertainmentTotal = analysisResult.totals.entertainment;
    }
    if (analysisResult.totals.bookingFee !== undefined) {
      bookingFeeTotal = analysisResult.totals.bookingFee;
    }
  }

  const grandTotal = foodTotal + drinksTotal + entertainmentTotal + bookingFeeTotal;

  return {
    food: parseFloat(foodTotal.toFixed(2)),
    drinks: parseFloat(drinksTotal.toFixed(2)),
    entertainment: parseFloat(entertainmentTotal.toFixed(2)),
    bookingFee: parseFloat(bookingFeeTotal.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2)),
    lineItems: analysisResult.lineItems || [],
    eventDetails: analysisResult.eventDetails || {},
    preloadedDrinks: analysisResult.preloadedDrinks || null
  };
}

// Upload endpoint - accepts up to 10 PDFs or PNGs
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
          entertainment: totals.entertainment + (result.breakdown.entertainment || 0),
          bookingFee: totals.bookingFee + (result.breakdown.bookingFee || 0),
          grandTotal: totals.grandTotal + (result.breakdown.grandTotal || 0)
        };
      }, { food: 0, drinks: 0, entertainment: 0, bookingFee: 0, grandTotal: 0 });

    res.json({
      success: true,
      results: results,
      combinedTotals: {
        food: parseFloat(combinedTotals.food.toFixed(2)),
        drinks: parseFloat(combinedTotals.drinks.toFixed(2)),
        entertainment: parseFloat(combinedTotals.entertainment.toFixed(2)),
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// Catch-all handler: serve index.html for any non-API routes
// This ensures the SPA works correctly
app.get('*', (req, res, next) => {
  // Don't handle API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  // Serve index.html for all other routes
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

