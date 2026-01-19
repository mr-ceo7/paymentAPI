const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const helmet = require('helmet');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "https:"],
            styleSrc: ["'self'", "'unsafe-inline'", "https:", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "https:", "wss:"],
        },
    },
})); 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

// CORS: Allow requests from frontend
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

const PORT = process.env.PORT || 5000;

// ... (Firebase Init Code remains same, skipping for brevity in this replace block if it was outside target range, but here I am targeting start of file effectively or just ensuring I don't delete it.
// Actually, I should probably do multiple chunks if I need to touch multiple places.
// The user instruction says "Update server.js".
// Let's use multi_replace for safety as edits are scattered.)

// RE-STRATEGIZING: switching to multi_replace because changes are scattered.


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

let lastAppHeartbeat = 0; // Timestamp of last poll from mobile app

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
        });

        // Broadcast Stats Update
        broadcastStats();


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
            enabled = true;
        }
    } else {
        // No key
        if (isDev) {
             // Enable in dev to test UI/Manual flow even without Lipana keys
             enabled = true;
        }
    }

    res.json({ 
        paymentsEnabled: true, 
        stkEnabled: enabled, 
        manualEnabled: true,
        env: process.env.NODE_ENV
    });
});

// MOCK DB (In-Memory)
const mockTransactions = new Map();

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

// 3. Manual Payment Endpoints (Fallback)

// Initiate Manual Payment
app.post('/api/manual-pay', async (req, res) => {
    const { code, planId, uid, phone } = req.body;

    if (!code || !planId || !uid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    // Sanitize code
    const uniqueCode = code.toUpperCase().trim();

    if (!/^[A-Z0-9]{10}$/.test(uniqueCode)) {
        return res.status(400).json({ error: 'Invalid M-Pesa Code format. Must be 10 characters.' });
    }

    try {
        if (db) {
            // Check if code already used
            const existing = await db.collection('transactions').where('mpesaCode', '==', uniqueCode).get();
            if (!existing.empty) {
                // If it exists but failed, maybe allow retry? For now, simplified:
                // actually, if it exists and is COMPLETED, reject.
                const isUsed = existing.docs.some(d => d.data().status === 'COMPLETED');
                if (isUsed) {
                    return res.status(400).json({ error: 'Transaction code already used' });
                }
            }

            // Create Transaction
            const docRef = db.collection('transactions').doc(); // Auto-ID
            await docRef.set({
                uid,
                planId,
                amount: plan.price,
                phone: phone || 'MANUAL',
                mpesaCode: uniqueCode,
                status: 'MANUAL_VERIFYING',
                type: 'MANUAL',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[Manual Pay] User ${uid} submitted code ${uniqueCode} for ${planId}`);
            
            // Emit Socket.IO event to notify mobile app
            io.emit('request_verification', { 
                transactionId: docRef.id,
                mpesaCode: uniqueCode,
                amount: plan.price
            });
            
            res.json({ success: true, transactionId: docRef.id, message: "Verification in progress" });
            broadcastStats();
            return;
        } else {
             console.log(`[MOCK DB] Manual Pay: ${uniqueCode} for ${planId}`);
             const mockId = `mock_txn_${Date.now()}`;
             mockTransactions.set(mockId, {
                id: mockId,
                uid,
                planId,
                amount: plan.price,
                phone: phone || 'MANUAL',
                mpesaCode: uniqueCode,
                status: 'MANUAL_VERIFYING',
                type: 'MANUAL',
                createdAt: new Date()
             });
             
             // Emit Socket.IO event even in mock mode
             io.emit('request_verification', { 
                transactionId: mockId,
                mpesaCode: uniqueCode,
                amount: plan.price
            });
             
             res.json({ success: true, transactionId: mockId, message: "Verification in progress" });
             broadcastStats();
        }

    } catch (error) {
        console.error("Manual Pay Error DETAILS:", error);
        console.error("Error stack:", error.stack);
        console.error("Error name:", error.name);
        console.error("Error message:", error.message);
        res.status(500).json({ error: 'Submission failed', details: error.message });
    }
});

// Check Transaction Status (Polling Fallback)
app.get('/api/transaction-status/:id', async (req, res) => {
    const { id } = req.params;
    try {
        if (!db) {
            // Mock
            const txn = mockTransactions.get(id);
            if (!txn) return res.status(404).json({ error: 'Transaction not found' });
            return res.json({ status: txn.status });
        }

        const doc = await db.collection('transactions').doc(id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Transaction not found' });
        
        return res.json({ status: doc.data().status });
    } catch (e) {
        console.error("Status Poll Error:", e);
        res.status(500).json({ error: 'Poll failed' });
    }
});

// Update status response
app.get('/api/payment-status', (req, res) => {
    // Check if Stripe/Lipana keys exist
    const hasKey = !!process.env.LIPANA_CONSUMER_KEY && !!process.env.LIPANA_CONSUMER_SECRET;
    const isDev = process.env.NODE_ENV !== 'production';
    
    let stkEnabled = hasKey;
    // if (!hasKey && isDev) stkEnabled = true; // Disable Mock to test fallback UI

    res.json({ 
        paymentsEnabled: true, 
        stkEnabled: stkEnabled, 
        manualEnabled: true,
        env: process.env.NODE_ENV,
        // Dynamic Payment Details
        payType: process.env.MPESA_PAYMENT_TYPE || 'Buy Goods (Till)',
        payNumber: process.env.MPESA_PAYMENT_NUMBER || '6960795',
        payName: process.env.MPESA_PAYMENT_NAME || 'UoN Smart Timetable'
    });
});

// Poll for Pending Verifications (Called by NTFY5 App)
app.get('/api/pending-verifications', async (req, res) => {
    lastAppHeartbeat = Date.now(); // Update heartbeat
    try {
        if (!db) {
            // Return from Mock DB
            const pending = Array.from(mockTransactions.values())
                .filter(t => t.status === 'MANUAL_VERIFYING')
                .map(t => ({
                    id: t.id,
                    code: t.mpesaCode,
                    amount: t.amount,
                    date: t.createdAt.toISOString()
                }));
            return res.json({ pending }); 
        }

        const snapshot = await db.collection('transactions')
            .where('status', '==', 'MANUAL_VERIFYING')
            .limit(50) // Batch size
            .get();

        const pending = snapshot.docs.map(doc => ({
            id: doc.id,
            code: doc.data().mpesaCode,
            amount: doc.data().amount,
            date: doc.data().createdAt?.toDate().toISOString() // Optional date check?
        }));

        res.json({ pending });
    } catch (error) {
        console.error("Fetch Pending Error:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Submit Verification Result (Called by NTFY5 App)
app.post('/api/verify-result', async (req, res) => {
    const { transactionId, isValid, metadata } = req.body;

    if (!transactionId || isValid === undefined) {
         return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        if (!db) {
            // Handle Mock DB
             if (mockTransactions.has(transactionId)) {
                const txn = mockTransactions.get(transactionId);
                if (txn.status !== 'MANUAL_VERIFYING') return res.status(400).json({ error: 'Not pending' });
                
                if (isValid) {
                    txn.status = 'COMPLETED';
                    txn.verifiedAt = new Date();
                    console.log(`[MOCK DB] Verified ${transactionId}`);
                } else {
                    txn.status = 'FAILED';
                    txn.verifiedAt = new Date();
                    console.log(`[MOCK DB] Rejected ${transactionId}`);
                }
                return res.json({ success: true });
            }
            return res.json({ success: true }); // Ignore if not found in mock
        }

        const txnRef = db.collection('transactions').doc(transactionId);
        const txnDoc = await txnRef.get();

        if (!txnDoc.exists) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const txnData = txnDoc.data();
        if (txnData.status !== 'MANUAL_VERIFYING') {
            return res.status(400).json({ error: 'Transaction not pending verification' });
        }

        if (isValid) {
            const plan = PLANS[txnData.planId];
            const userRef = db.collection('users').doc(txnData.uid);

            // Fulfill
             if (txnData.planId === 'unlimited') {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);
                await userRef.update({
                    unlimitedExpiresAt: expiresAt.toISOString(),
                    lastPaymentRef: transactionId
                });
            } else {
                await userRef.update({
                    credits: admin.firestore.FieldValue.increment(plan.credits),
                    lastPaymentRef: transactionId
                });
            }

            await txnRef.update({ 
                status: 'COMPLETED', 
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                verificationMetadata: metadata || {} 
            });
            console.log(`[Manual Verify] Validated ${transactionId}`);
        } else {
             await txnRef.update({ 
                status: 'FAILED', 
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                 verificationMetadata: metadata || {} 
            });
            console.log(`[Manual Verify] Rejected ${transactionId}`);
        }

        res.json({ success: true });

    } catch (error) {
        console.error("Verify Result Error:", error);
        res.status(500).json({ error: 'Update failed' });
    }
});


// --- DASHBOARD ENDPOINTS ---

// Shared Stats Logic
async function getStatsData() {
    const isConnected = (Date.now() - lastAppHeartbeat) < 8000;
    
    let stats = {
        verified: 0,
        rejected: 0,
        pending: 0,
        revenue: 0,
        isPhoneConnected: isConnected,
        recentTransactions: []
    };

    if (db) {
        const snapshot = await db.collection('transactions').get();
        const txns = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            txns.push({
                id: doc.id,
                ...data,
                date: (data.createdAt && data.createdAt.toDate) ? data.createdAt.toDate() : new Date()
            });
            
            if (data.status === 'COMPLETED') {
                stats.verified++;
                stats.revenue += (data.amount || 0);
            } else if (data.status === 'FAILED') {
                stats.rejected++;
            } else if (data.status === 'MANUAL_VERIFYING' || data.status === 'PENDING') {
                stats.pending++;
            }
        });
        
        // Sort and slice for recent
        stats.recentTransactions = txns.sort((a,b) => b.date - a.date).slice(0, 10);
        
    } else {
        // Mock Stats
        const txns = Array.from(mockTransactions.values());
        txns.forEach(t => {
            if (t.status === 'COMPLETED') {
                stats.verified++;
                stats.revenue += (t.amount || 0);
            } else if (t.status === 'FAILED') stats.rejected++;
            else if (t.status === 'MANUAL_VERIFYING' || t.status === 'PENDING') stats.pending++;
        });
        stats.recentTransactions = txns.sort((a,b) => b.createdAt - a.createdAt).slice(0, 10);
    }
    return stats;
}

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const stats = await getStatsData();
        res.json(stats);
    } catch (e) {
        console.error("Dashboard Stats Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- BACKGROUND TASKS ---

// Periodically expire stale transactions (Stuck in 'MANUAL_VERIFYING' for > 60s)
// This handles cases where the Admin App missed the transaction or looked it up but found nothing (and didn't report back yet)
setInterval(async () => {
    try {
        if (db) {
            const cutoff = new Date(Date.now() - 60000); // 60 seconds ago
            
            const snapshot = await db.collection('transactions')
                .where('status', '==', 'MANUAL_VERIFYING')
                .get();

            if (snapshot.empty) return;

            const batch = db.batch();
            let updateCount = 0;

            snapshot.forEach(doc => {
                const data = doc.data();
                // createdAt can be null instantly after creation (latency), check existence
                if (data.createdAt && data.createdAt.toDate() < cutoff) {
                    batch.update(doc.ref, { 
                        status: 'FAILED',
                        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                        failureReason: 'Timeout - Code not found or System busy'
                    });
                    updateCount++;
                }
            });

            if (updateCount > 0) {
                await batch.commit();
                console.log(`[Cleanup] Expired ${updateCount} stale transactions.`);
            }
        } else {
            // Cleanup Mock
            const cutoff = Date.now() - 60000;
            mockTransactions.forEach(t => {
                if (t.status === 'MANUAL_VERIFYING' && t.createdAt.getTime() < cutoff) {
                    t.status = 'FAILED';
                    t.verifiedAt = new Date();
                    console.log(`[Cleanup Mock] Expired ${t.id}`);
                }
            });
        }
    } catch (error) {
        console.error("[Cleanup] Error expiring transactions:", error);
    }
}, 10000); // Run every 10 seconds

// Dashboard: Clear All Stats
app.post('/api/dashboard/clear-stats', async (req, res) => {
    try {
        if (db) {
            const snapshot = await db.collection('transactions').get();
            const batch = db.batch();
            snapshot.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log(`[Dashboard] Cleared ${snapshot.size} transactions`);
            res.json({ success: true, deleted: snapshot.size });
        } else {
            // Clear mock
            const count = mockTransactions.size;
            mockTransactions.clear();
            res.json({ success: true, deleted: count });
        }
        broadcastStats(); // Update clients
    } catch (e) {
        console.error("[Dashboard] Clear stats error:", e);
        res.status(500).json({ error: "Failed to clear stats" });
    }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());


// Dashboard: Live Logs (Server-Sent Events)
const logBuffer = [];
const MAX_LOG_BUFFER = 100;

// Override console.log to capture logs
const originalLog = console.log;
console.log = (...args) => {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    const timestamp = new Date().toISOString();
    logBuffer.push({ timestamp, message });
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
    originalLog.apply(console, args);
    // Emit Log to Dashboard
    if(io) io.emit('server_log', { timestamp, message }); 
};

app.get('/api/dashboard/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send buffered logs first
    logBuffer.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });
    
    // Send new logs as they come
    const interval = setInterval(() => {
        if (logBuffer.length > 0) {
            const latest = logBuffer[logBuffer.length - 1];
            res.write(`data: ${JSON.stringify(latest)}\n\n`);
        }
    }, 1000);
    
    req.on('close', () => clearInterval(interval));
});

// APK Download endpoint
app.get('/api/download/app', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'paymentAPI.apk');
    if (fs.existsSync(apkPath)) {
        res.download(apkPath, 'paymentAPI.apk');
    } else {
        res.status(404).json({ error: 'APK not found. Please build and upload the release APK.' });
    }
});

app.listen(PORT, () => {
    console.log(`Secure Server running on port ${PORT}`);
});
