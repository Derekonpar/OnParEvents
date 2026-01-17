# Food Portal - Party Sheet Analyzer

A localhost npm portal for analyzing party detail sheets and breaking down costs by category (Food, Drinks, Entertainment).

## Features

- 📄 Upload up to 10 PDF or PNG party detail sheets at once
- 🤖 AI-powered analysis using OpenAI API (text extraction for PDFs, vision API for PNGs)
- 💰 Automatic cost breakdown into:
  - **Food** (Front Nine, Full Course food portion)
  - **Drinks** (Back Nine, preloaded RFID amounts)
  - **Entertainment** (bowling, darts, etc.)
- 🧮 Smart calculation: Automatically handles "Full Course" packages by subtracting preloaded drink costs from food total
- 📊 Detailed line item breakdown
- 🎨 Clean, modern web interface

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure OpenAI API Key:**
   Create a `.env` file in the root directory:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Start the server:**
   ```bash
   npm run dev
   ```

5. **Open in browser:**
   Navigate to `http://localhost:3000`

## How It Works

1. Upload one or more PDF or PNG party detail sheets (up to 10)
2. The system processes files:
   - **PDFs**: Extracts text and analyzes with GPT-4
   - **PNGs**: Uses Vision API to analyze images directly
3. OpenAI analyzes the content and identifies:
   - Event details (name, date, time, guests, contact)
   - Food items and costs
   - Drink packages and preloaded amounts
   - Entertainment items (bowling, darts, etc.)
4. Costs are automatically categorized and calculated
5. Results are displayed with a detailed breakdown

## Cost Calculation Logic

- **Front Nine**: Food only → goes to Food total
- **Back Nine**: Drinks only → goes to Drinks total
- **Full Course**: Food + Drinks
  - If preloaded drinks are detected (e.g., 100 people × $15 drink bracelets)
  - Drinks amount = quantity × price per person
  - Food amount = total - drinks amount
  - The system automatically subtracts drink costs from food and adds to drinks

## Requirements

- Node.js (v14 or higher)
- OpenAI API key
- PDF or PNG files with party detail information

## Project Structure

```
foodsheettest/
├── server.js          # Express server with OpenAI integration
├── public/
│   └── index.html     # Frontend UI
├── uploads/           # Temporary file storage (auto-created)
├── .env               # Environment variables (create this)
└── package.json       # Dependencies

```

