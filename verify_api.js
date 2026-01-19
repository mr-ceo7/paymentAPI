const axios = require('axios');

const BASE_URL = 'http://localhost:5001';
const UID = 'test_user_verify_123';

async function runTest() {
    try {
        console.log('--- STARTING VERIFICATION ---');

        // 1. Check Status
        console.log('\n[1] Checking Payment Status...');
        const statusRes = await axios.get(`${BASE_URL}/api/payment-status`);
        console.log('Status:', statusRes.data.paymentsEnabled ? 'OK' : 'FAIL');

        // 2. Initial Credits
        console.log('\n[2] Checking Initial Credits...');
        const credRes1 = await axios.get(`${BASE_URL}/api/user/credits?uid=${UID}`);
        console.log('Initial Credits:', credRes1.data.credits);

        // 3. Add Credits via Mock Payment (Manual Flow)
        console.log('\n[3] Simulating Manual Payment...');
        const code = 'TEST' + Math.floor(Math.random() * 1000000).toString().padEnd(6, '0');
        const payRes = await axios.post(`${BASE_URL}/api/manual-pay`, {
            uid: UID,
            planId: 'starter', // 3 credits
            phone: '0712345678',
            code: code 
        });
        const txnId = payRes.data.transactionId;
        console.log('Payment Initiated, TxnID:', txnId);

        // 4. Verify Payment (Admin Side)
        console.log('\n[4] Verifying Payment (Admin Action)...');
        await axios.post(`${BASE_URL}/api/verify-result`, {
            transactionId: txnId,
            isValid: true,
            metadata: { method: 'script' }
        });
        console.log('Payment Verified.');

        // 5. Check Credits Increased
        console.log('\n[5] Checking Updated Credits...');
        const credRes2 = await axios.get(`${BASE_URL}/api/user/credits?uid=${UID}`);
        console.log('Credits After Pay:', credRes2.data.credits);
        
        if (credRes2.data.credits > credRes1.data.credits) {
            console.log('SUCCESS: Credits verified!');
        } else {
            console.log('FAIL: Credits did not increase.');
        }

        // 6. Consume Credit
        console.log('\n[6] Consuming 1 Credit...');
        const consumeRes = await axios.post(`${BASE_URL}/api/user/consume`, { uid: UID });
        console.log('Consume Result:', consumeRes.data.success ? 'OK' : 'FAIL', 'Remaining:', consumeRes.data.remaining);

        // 7. Final Check
        const credRes3 = await axios.get(`${BASE_URL}/api/user/credits?uid=${UID}`);
        console.log('Final Credits:', credRes3.data.credits);

        if (credRes3.data.credits === credRes2.data.credits - 1) {
            console.log('SUCCESS: Consumption verified!');
        } else {
            console.log('FAIL: Consumption count mismatch.');
        }

        console.log('\n--- VERIFICATION COMPLETE ---');

    } catch (e) {
        console.error('TEST FAILED:', e.message);
        if (e.response) {
            console.error('Response:', e.response.status, e.response.data);
        }
    }
}

runTest();
