const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const helmet = require('helmet');

dotenv.config();

const app = express();
app.use(helmet()); 
app.use(express.json());
// CORS: Allow requests from frontend
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

const PORT = process.env.PORT || 5000;

// Initialize Firebase Admin
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin Initialized");
    } else {
        console.warn("WARNING: FIREBASE_SERVICE_ACCOUNT missing. Credit updates will fail.");
    }
} catch (e) {
    console.error("Firebase Admin Init Error:", e);
}

const db = admin.apps.length > 0 ? admin.firestore() : null;

if (!db) {
    console.warn("⚠️ RUNNING IN OFFLINE/MOCK MODE (No Firebase Creds)");
}

// Lipana Config
const LIPANA_BASE_URL = 'https://api.lipana.dev/v1';

// Plans (Sync with frontend if needed, but validation happens here)
const PLANS = {
    'starter': { credits: 3, price: 1 },
    'pro': { credits: 19, price: 9 },
    'unlimited': { credits: 9999, price: 99, durationDays: 30 }
};

app.get('/', (req, res) => {
    res.send('UoN Smart Timetable Secure Backend 🛡️');
});

// 1. Initiate Payment
app.post('/api/pay', async (req, res) => {
    const { phone, planId, uid } = req.body;

    if (!phone || !planId || !uid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const API_KEY = process.env.LIPANA_SECRET_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server misconfiguration' });

    try {
        console.log(`[Pay] User ${uid} requesting ${planId} (${plan.price})`);

        // Create Pending Transaction in Firestore
        // We do this BEFORE calling Lipana to ensure we have a record to update later
        // Use a temp ID or wait for Lipana response? 
        // Better: Wait for response to get CheckoutRequestID
        
        let response;
        let checkoutReqId;

        // MOCK MODE: Bypass Lipana if using mock key
        if (API_KEY === 'lip_sk_test_mock_key') {
            console.log(`[MOCK PAY] Simulating STK Push for ${phone}`);
            checkoutReqId = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Auto-trigger successful webhook after 3 seconds
            setTimeout(async () => {
                console.log(`[MOCK PAY] Triggering success callback for ${checkoutReqId}`);
                try {
                    await axios.post(`http://localhost:${PORT}/api/callback`, {
                        checkoutRequestID: checkoutReqId,
                        status: 'Success',
                        amount: plan.price
                    });
                } catch (e) {
                    console.error("[MOCK PAY] Callback trigger failed:", e.message);
                }
            }, 3000);

            // Mock Response structure
            response = { data: { data: { checkoutRequestID: checkoutReqId } } };
        } else {
            // REAL MODE: Call Lipana
             response = await axios.post(
                `${LIPANA_BASE_URL}/transactions/push-stk`,
                { phone, amount: plan.price },
                { headers: { 'Authorization': `Bearer ${API_KEY}` } }
            );
            checkoutReqId = response.data.data?.checkoutRequestID;
        }


        if (!checkoutReqId) throw new Error("No CheckoutRequestID from Lipana");

        // Save Transaction
        if (db) {
            await db.collection('transactions').doc(checkoutReqId).set({
                uid,
                planId,
                amount: plan.price,
                phone,
                status: 'PENDING',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
             console.log(`[MOCK DB] Saved transaction ${checkoutReqId} - PENDING`);
        }

        res.json({ 
            success: true, 
            message: "STK Push Sent", 
            checkoutRequestID: checkoutReqId 
        });

    } catch (error) {
        console.error("Payment Init Error:", error.message);
        res.status(500).json({ error: 'Payment initiation failed' });
    }
});

// 2. Check Payment Readiness (Feature Flag)
app.get('/api/payment-status', (req, res) => {
    const hasKey = !!process.env.LIPANA_SECRET_KEY;
    const isMock = process.env.LIPANA_SECRET_KEY === 'lip_sk_test_mock_key';
    const isDev = process.env.NODE_ENV === 'development';
    
    // Logic: Enable if we have a key. 
    // IF production: Must have real key (not mock) OR just any key? 
    // User said: "IF BACKEND IS NOT READY... UNLESS WE ARE ON DEVELOPMENT".
    // "Ready" implies having the key.
    
    let enabled = false;

    if (hasKey) {
        if (isDev) {
            enabled = true; // Always enable in dev if key exists (even mock)
        } else {
            // In Production (or non-dev)
            // Enable only if key exists. Mock key might be undesirable in prod? 
            // User said: "SET LIPANA KEYS LATER".
            // So if key is missing -> false. If present -> true.
            enabled = true;
        }
    } else {
        // No key
        if (isDev) {
             // Allow enabling in dev without key? No, logic relies on key.
             // But maybe for UI testing we want it?
             // User said: "UNLESS WE ARE ON DEVELOPMENT ON LOCAL HOST" implies dev *can* show it even if "not ready"?
             // Actually, usually dev enviroment has .env with mock key.
             // Let's stick to: Enabled if Key exists.
             enabled = false;
        }
    }

    res.json({ 
        paymentsEnabled: enabled,
        env: process.env.NODE_ENV
    });
});

// 2. Webhook Callback
app.post('/api/callback', async (req, res) => {
    try {
        const { checkoutRequestID, status, amount } = req.body;
        // Verify signature here using LIPANA_IV_KEY if available (TODO)
        
        console.log(`[Webhook] ${checkoutRequestID} - ${status}`);

        if (!checkoutRequestID) return res.sendStatus(400);

        if (!db) {
             console.log(`[MOCK DB] processing callback for ${checkoutRequestID}`);
             return res.sendStatus(200);
        }

        const txnRef = db.collection('transactions').doc(checkoutRequestID);
        const txnDoc = await txnRef.get();

        if (!txnDoc.exists) {
            console.error("Transaction not found:", checkoutRequestID);
            return res.sendStatus(404);
        }

        const txnData = txnDoc.data();
        if (txnData.status === 'COMPLETED') return res.sendStatus(200); // Idempotency

        if (status === 'Success' || status === 'Completed') {
            const plan = PLANS[txnData.planId];
            const userRef = db.collection('users').doc(txnData.uid);

            // Fulfill Credits
            if (txnData.planId === 'unlimited') {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);
                await userRef.update({
                    unlimitedExpiresAt: expiresAt.toISOString(),
                    lastPaymentRef: checkoutRequestID
                });
            } else {
                await userRef.update({
                    credits: admin.firestore.FieldValue.increment(plan.credits),
                    lastPaymentRef: checkoutRequestID
                });
            }

            // Update Transaction
            await txnRef.update({ status: 'COMPLETED', confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
            console.log(`[Fulfillment] User ${txnData.uid} credited.`);
        } else {
            await txnRef.update({ status: 'FAILED' });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error);
        res.sendStatus(500);
    }
});

app.listen(PORT, () => {
    console.log(`Secure Server running on port ${PORT}`);
});
