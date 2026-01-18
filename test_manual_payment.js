import axios from 'axios';

const BASE_URL = 'http://localhost:5001'; // Backend running on 5001

async function testManualPaymentFlow() {
    try {
        console.log("1. Initiating Manual Payment...");
        const payRes = await axios.post(`${BASE_URL}/api/manual-pay`, {
            code: 'TEST_' + Date.now(),
            planId: 'pro',
            uid: 'test_user_123',
            phone: '0712345678'
        });
        console.log("init response:", payRes.data);

        console.log("2. Checking Pending Verifications (NTFY5 Polling)...");
        const pendingRes = await axios.get(`${BASE_URL}/api/pending-verifications`);
        console.log("pending response:", pendingRes.data);
        
        const tx = pendingRes.data.pending.find(t => t.code.startsWith('TEST_'));
        if (!tx) {
            console.error("FAILED: Transaction not found in pending list");
            return;
        }
        console.log("Found transaction:", tx);

        console.log("3. Simulating NTFY5 Verification Result (Valid)...");
        const verifyRes = await axios.post(`${BASE_URL}/api/verify-result`, {
            transactionId: tx.id,
            isValid: true,
            metadata: { source: 'test_script' }
        });
        console.log("verify response:", verifyRes.data);

        console.log("4. Checking Pending again (should be empty/processed)...");
        const pendingRes2 = await axios.get(`${BASE_URL}/api/pending-verifications`);
        const tx2 = pendingRes2.data.pending.find(t => t.id === tx.id);
        if (tx2) {
             console.error("FAILED: Transaction still pending after verification");
        } else {
             console.log("SUCCESS: Transaction removed from pending list (Completed)");
        }

    } catch (error) {
        console.error("TEST FAILED:", error.response ? error.response.data : error.message);
    }
}

testManualPaymentFlow();
