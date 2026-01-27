
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { extractTextFromPDF, parseWithGemini } = require('../services/ai_extractor');

// Load env
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

const PDF_PATH = path.join(__dirname, '../../components/Degree Exam Timetable Feb 2026.xls - Sheet1 (1).pdf');

async function runTest() {
    console.log("🧪 Starting AI Extractor Test...");

    // 1. Test PDF Extraction
    if (!fs.existsSync(PDF_PATH)) {
        console.error("❌ Test PDF not found at:", PDF_PATH);
        process.exit(1);
    }

    console.log("📄 Extracting text from PDF...");
    try {
        const buffer = fs.readFileSync(PDF_PATH);
        const text = await extractTextFromPDF(buffer);
        
        if (text.length > 100 && text.includes("TECHNICAL UNIVERSITY OF KENYA")) {
            console.log("✅ PDF Extraction Passed (Found expected header)");
        } else {
            console.error("❌ PDF Extraction Failed: Text seems invalid or empty");
            console.log("Preview:", text.substring(0, 200));
        }

        // 2. Test AI Parsing (Real Integration Test) using real PDF text
        // Note: This consumes detailed API calls. We will test with a small chunk.
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.warn("⚠️  Skipping AI Test: GEMINI_API_KEY not found");
            return;
        }

        console.log("🤖 Testing AI Parsing (Gemini)...");
        // Mocking a smaller chunk to save tokens/time for this test
        const sampleText = text.substring(0, 5000); 
        
        const result = await parseWithGemini(sampleText, apiKey);
        
        if (result && Array.isArray(result.units) && result.units.length > 0) {
            console.log(`✅ AI Parsing Passed: Found ${result.units.length} units`);
            const first = result.units[0];
            console.log("   Sample Unit:", JSON.stringify(first));
            
            if (first.code && first.title && first.date) {
                 console.log("✅ Unit Structure Valid");
            } else {
                 console.error("❌ Unit Structure Invalid:", first);
            }
        } else {
            console.error("❌ AI Parsing Failed: No units found", result);
        }

    } catch (e) {
        console.error("❌ Test Failed with Exception:", e);
    }
}

runTest();
