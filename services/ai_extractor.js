const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
// const pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); // Not used, using dynamic import below
const CONFIG = {
  // Use the models detected in verify-ai.js
  MODEL_NAME: 'gemini-2.0-flash', 
};

/**
 * Extract text from PDF buffer using PDF.js
 * @param {Buffer} buffer 
 */
async function extractTextFromPDF(buffer) {
  // Dynamic import for ESM module support in CommonJS
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument(data);
  const pdfDocument = await loadingTask.promise;
  
  let fullText = "";
  const numPages = pdfDocument.numPages;

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(" ");
    fullText += `--- Page ${i} ---\n${pageText}\n`;
  }
  
  return fullText;
}

/**
 * Use Gemini to parse the raw text into structured ExamUnit[]
 * @param {string} rawText 
 * @param {string} apiKey 
 */
// Collect all available keys
const API_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY1,
    process.env.GEMINI_API_KEY2,
    process.env.GEMINI_API_KEY3,
    process.env.GEMINI_API_KEY4,
    process.env.GEMINI_API_KEY5
].filter(k => !!k && k.length > 10);

const CUSTOM_API_URL = process.env.CUSTOM_API_URL || "http://127.0.0.1:5000";
const AI_PRIORITY = process.env.AI_PRIORITY || "gemini";

/**
 * Helper to call standard Gemini SDK with a specific key
 */
async function generateWithKey(apiKey, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });
  
  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

/**
 * Custom API Fallback (Python Gateway)
 */
async function callCustomFallback(prompt) {
    if (!CUSTOM_API_URL) throw new Error("No Custom API URL configured");
    console.log(`⚠️ Attempting fallback to Custom API (${CUSTOM_API_URL})...`);
    
    // We don't have file context support here yet (passed as text in prompt), 
    // so we just use the generate endpoint with the raw prompt.
    const payload = {
        prompt: prompt,
        files: [] // No file context for this specific extractor flow yet
    };

    const generateRes = await fetch(`${CUSTOM_API_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!generateRes.ok) throw new Error("Custom API request failed");
    const genData = await generateRes.json();
    return genData.response;
}

/**
 * Robust Generation Strategy:
 * 1. Respect AI_PRIORITY (custom vs gemini)
 * 2. Rotate through API_KEYS if using Gemini
 * 3. Fallback to the other method on failure
 */
async function generateWithStrategy(prompt) {
  const tryGemini = async () => {
    let lastError = null;
    for (let i = 0; i < API_KEYS.length; i++) {
        try {
            console.log(`Attempting Gemini Key #${i+1}...`);
            return await generateWithKey(API_KEYS[i], prompt);
        } catch (e) {
            console.warn(`Gemini Key #${i+1} failed: ${e.message}`);
            lastError = e;
        }
    }
    throw lastError || new Error("All Gemini keys failed");
  };

  const tryCustom = async () => {
      return await callCustomFallback(prompt);
  };

  if (AI_PRIORITY === 'custom') {
      try {
          return await tryCustom();
      } catch (e) {
          console.warn("Custom API failed, falling back to Gemini...", e.message);
          return await tryGemini();
      }
  } else {
      try {
          return await tryGemini();
      } catch (e) {
          console.warn("Gemini SDK failed, falling back to Custom API...", e.message);
          return await tryCustom();
      }
  }
}

async function parseWithGemini(rawText, _unusedApiKey) { // apiKey arg ignored, using internal rotation
  const prompt = `
    You are an expert data extraction assistant. 
    I will provide you with the raw text extracted from a university exam timetable PDF.
    Your task is to extract the exam units into a structured JSON array.

    The format of the input text is unstructured and may contain headers, footers, and noise.
    
    Structure your output strictly as a JSON object with a single key "units", which is an array of objects.
    Each object must have:
    - "date": String (YYYY-MM-DD format). If the year is missing, assume next upcoming February. If date is ambiguous, make a best guess.
    - "time": String (e.g., "8:00 am - 10:00 am").
    - "code": String (The unit code, e.g., "UCCC 1101").
    - "title": String (The unit title).
    - "venue": String (e.g., "J31, S301").
    - "level": Number (Year of study, try to infer from Code e.g. 1st digit, or context. Default to 0 if unknown).
    - "department": String (Optional, infer from context e.g. "Mechanical", "Aerospace", or "Common").

    Correct any obvious OCR errors (e.g. "l" for "1", "O" for "0" in times).
    Combine multi-line titles if they are split.

    RAW TEXT:
    ${rawText.substring(0, 30000)} 
  `;

  try {
    const text = await generateWithStrategy(prompt);
    
    // sanitized JSON parsing
    const jsonBlock = text.match(/```json\n([\s\S]*?)\n```/) || [null, text];
    const cleanJson = jsonBlock[1] || text;
    
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Extraction Error:", error);
    throw new Error("Failed to parse data with AI Strategy");
  }
}

module.exports = {
  extractTextFromPDF,
  parseWithGemini
};
