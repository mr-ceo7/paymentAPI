const axios = require('axios');

const API_URL = 'http://localhost:5001/api';
const TEST_UID = 'test_backend_verify_user';

async function runTest() {
    console.log("🚀 Starting Backend Credit Test...");

    try {
        // 1. Reset/Set Credits to 5 via Admin API (Simulating a known state)
        console.log(`\nUNKNOWN STATE -> Setting credits to 5 for ${TEST_UID}...`);
        // Note: Admin endpoint might require different setup, but let's try calling it.
        // Based on server.js: app.post('/api/admin/users/:uid/credits', ...)
        await axios.post(`${API_URL}/admin/users/${TEST_UID}/credits`, {
            credits: 5,
            isUnlimited: false
        });
        console.log("✅ Credits set to 5.");

        // 2. Verify Initial State
        console.log("\n📡 Fetching current credits...");
        const initRes = await axios.get(`${API_URL}/user/credits?uid=${TEST_UID}`);
        console.log("Current Balance:", initRes.data);
        if (initRes.data.credits !== 5) throw new Error("Failed to set initial credits!");

        // 3. Consume 1 Credit
        console.log("\n📉 Consuming 1 Credit (Triggering /api/user/consume)...");
        const consumeRes = await axios.post(`${API_URL}/user/consume`, {
            uid: TEST_UID
        });
        
        console.log("Response:", consumeRes.data);

        // 4. Verify Deduction Logic
        if (!consumeRes.data.success) throw new Error("Consume request failed!");
        if (consumeRes.data.remaining !== 4) throw new Error(`Expected remaining 4, got ${consumeRes.data.remaining}`);
        console.log("✅ API successfully returned new balance (4). Information for Frontend Sync is PRESENT.");

        // 5. Verify Persistence
        console.log("\n💾 Verifying database persistence...");
        const finalRes = await axios.get(`${API_URL}/user/credits?uid=${TEST_UID}`);
        if (finalRes.data.credits !== 4) throw new Error("Database did not persist deduction!");
        console.log("✅ Database persisted new balance (4).");

        console.log("\n🎉 TEST PASSED! Backend logic is consistent.");

    } catch (e) {
        console.error("\n❌ TEST FAILED:", e.message);
        if (e.response) {
            console.error("API Error Data:", e.response.data);
        }
    }
}

runTest();
