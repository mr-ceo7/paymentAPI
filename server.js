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
const LocalDB = require('./database');
const SyncService = require('./services/sync');

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
            scriptSrcAttr: ["'unsafe-inline'"],
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


// Initialize Local DB & Sync
(async () => {
    try {
        await LocalDB.init();
        if (db) SyncService.start(db);
    } catch (e) {
        console.error("Failed to init LocalDB:", e);
    }
})();

// Helper: Broadcast Stats to Dashboard
async function broadcastStats() {
    try {
        const stats = await getStatsData(); // reused existing helper which uses LocalDB
        io.emit('dashboard_stats', stats);
    } catch (e) {
        console.error("Broadcast Stats Error:", e);
    }
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

        // Save Transaction Locally (Syncs to Cloud automatically)
        await LocalDB.createTransaction({
            id: checkoutReqId,
            uid,
            planId,
            amount: plan.price,
            phone,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        });

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
// 2. Webhook Callback

// 2. Webhook Callback
app.post('/api/callback', async (req, res) => {
    try {
        const { checkoutRequestID, status, amount } = req.body;
        // Verify signature here using LIPANA_IV_KEY if available (TODO)
        
        console.log(`[Webhook] ${checkoutRequestID} - ${status}`);

        if (!checkoutRequestID) return res.sendStatus(400);

        const txn = await LocalDB.getTransaction(checkoutRequestID);
        if (!txn) {
            console.error("Transaction not found:", checkoutRequestID);
            return res.sendStatus(404);
        }

        if (txn.status === 'COMPLETED') return res.sendStatus(200);

        if (status === 'Success' || status === 'Completed') {
            const plan = PLANS[txn.planId];
            
            // Fulfill Credits & Update Status
            await LocalDB.updateUserCredits(
                txn.uid, 
                plan.credits, 
                txn.planId === 'unlimited', 
                checkoutRequestID
            );

            await LocalDB.updateTransactionStatus(checkoutRequestID, 'COMPLETED', {
                verifiedAt: new Date().toISOString()
            });
            
            console.log(`[Fulfillment] User ${txn.uid} credited.`);
        } else {
            await LocalDB.updateTransactionStatus(checkoutRequestID, 'FAILED');
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
        // Check for duplicates
        // Implementation note: getTransactionByCode logic
        const existing = await LocalDB.getTransactionByCode(uniqueCode);
        if (existing && existing.status === 'COMPLETED') {
             return res.status(400).json({ error: 'Transaction code already used' });
        }

        const transactionId = `txn_${Date.now()}`;
        
        // Save
        await LocalDB.createTransaction({
            id: transactionId,
            uid,
            planId,
            amount: plan.price,
            phone: phone || 'MANUAL',
            mpesaCode: uniqueCode,
            status: 'MANUAL_VERIFYING',
            type: 'MANUAL',
            createdAt: new Date().toISOString()
        });

        console.log(`[Manual Pay] User ${uid} submitted code ${uniqueCode}`);

        io.emit('request_verification', { transactionId, mpesaCode: uniqueCode, amount: plan.price });
        
        res.json({ success: true, transactionId, message: "Verification in progress" });
        broadcastStats();

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
        const txn = await LocalDB.getTransaction(id);
        if (!txn) return res.status(404).json({ error: 'Transaction not found' });
        return res.json({ status: txn.status });
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
        const pending = await LocalDB.getPendingVerifications();
        // Format for frontend
        const formatted = pending.map(t => ({
            id: t.id,
            code: t.mpesaCode,
            amount: t.amount,
            date: t.createdAt
        }));
        res.json({ pending: formatted });
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
        const txn = await LocalDB.getTransaction(transactionId);
        if (!txn) return res.status(404).json({ error: 'Transaction not found' });
        if (txn.status !== 'MANUAL_VERIFYING') return res.status(400).json({ error: 'Not pending' });

        if (isValid) {
            const plan = PLANS[txn.planId];
            await LocalDB.updateUserCredits(txn.uid, plan.credits, txn.planId === 'unlimited', transactionId);
            await LocalDB.updateTransactionStatus(transactionId, 'COMPLETED', {
                verifiedAt: new Date().toISOString(),
                verificationMetadata: metadata
            });
            console.log(`[Manual Verify] Validated ${transactionId}`);
        } else {
            await LocalDB.updateTransactionStatus(transactionId, 'FAILED', {
                verifiedAt: new Date().toISOString(),
                verificationMetadata: metadata
            });
            console.log(`[Manual Verify] Rejected ${transactionId}`);
        }
        res.json({ success: true });
        broadcastStats();

    } catch (error) {
        console.error("Verify Result Error:", error);
        res.status(500).json({ error: 'Update failed' });
    }
});

// 4. User Credit Management (API for Frontend)
app.get('/api/user/credits', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'Missing UID' });

    try {
        const user = await LocalDB.getUser(uid);
        if (!user) {
            // Default for new user
            return res.json({ credits: 0, isUnlimited: false });
        }

        // Check Unlimited Expiry
        let isUnlimited = false;
        if (user.unlimitedExpiresAt) {
             if (new Date(user.unlimitedExpiresAt) > new Date()) {
                 isUnlimited = true;
             }
        }

        res.json({ 
            credits: user.credits || 0, 
            isUnlimited,
            unlimitedExpiresAt: user.unlimitedExpiresAt 
        });
    } catch (e) {
        console.error("Get Credits Error:", e);
        res.status(500).json({ error: 'Failed to fetch credits' });
    }
});

app.post('/api/user/consume', async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'Missing UID' });

    try {
        const user = await LocalDB.getUser(uid);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Check Unlimited
        if (user.unlimitedExpiresAt && new Date(user.unlimitedExpiresAt) > new Date()) {
            return res.json({ success: true, remaining: 9999, message: 'Unlimited Plan Active' });
        }

        if (user.credits > 0) {
            const newCredits = user.credits - 1;
            // Update DB
            // We need a specific method or just reuse updateUserCredits with logic?
            // reuse updateUserCredits requires explicit args. Let's make a decrement helper or just use raw SQL here for speed/atomic? 
            // LocalDB.updateUserCredits is upsert/overwrite.
            // Let's add specific consume method to LocalDB or just raw sql via db.run
            // Ideally we stick to LocalDB encapsulation. I'll add consumeCredit to LocalDB for cleaner code or just use upsert with new value.
            
            // Re-using updateUserCredits is tricky because it adds. 
            // Let's implement direct SQL update here since we have the instance if we exported it? 
            // Better: Add consume method to LocalDB in next step? Or since I'm editing server.js, maybe I can just do a precise update if I had the method.
            // I'll update LocalDB first? No, I am in server.js task.
            // Actually, I can use `updateUserCredits` passing negative? No, it sets absolute value.
            // I will use `updateUserCredits` but passing calculated value `newCredits`.
            
            await LocalDB.updateUserCredits(uid, -1, false, 'CONSUME'); // Wait, updateUserCredits adds `creditsToAdd`.
            // Let's check LocalDB implementation.
            /* 
            async updateUserCredits(uid, creditsToAdd, isUnlimited, txnRef) {
                // ...
                newCredits += creditsToAdd; 
            */
            // Yes, it acts as incrementer! So passing -1 works perfectly.
            
            res.json({ success: true, remaining: newCredits });
        } else {
            res.status(403).json({ error: 'Insufficient credits' });
        }
    } catch (e) {
        console.error("Consume Credit Error:", e);
        res.status(500).json({ error: 'Failed to consume credit' });
    }
});

// --- DASHBOARD ENDPOINTS ---

// Shared Stats Logic
async function getStatsData() {
    const isConnected = (Date.now() - lastAppHeartbeat) < 8000;
    const stats = await LocalDB.getStats();
    return { ...stats, isPhoneConnected: isConnected };
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

// --- ADMIN API (Database Manager) ---

app.get('/api/admin/transactions', async (req, res) => {
    try {
        const txns = await LocalDB.getAllTransactions();
        res.json(txns);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const changes = await LocalDB.deleteTransaction(id);
        if (changes > 0) broadcastStats();
        res.json({ success: true, deleted: changes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/transactions', async (req, res) => {
    try {
        const data = req.body;
        // Basic validation
        if (!data.uid || !data.amount) return res.status(400).json({ error: "Missing UID or Amount" });
        
        const id = data.id || `txn_manual_${Date.now()}`;
        await LocalDB.createTransaction({
            id,
            uid: data.uid,
            planId: data.planId || 'manual',
            amount: data.amount,
            phone: data.phone || 'N/A',
            mpesaCode: data.mpesaCode || 'MANUAL_ENTRY',
            status: data.status || 'COMPLETED',
            type: 'MANUAL_ADMIN',
            createdAt: new Date().toISOString(),
            ...data
        });
        
        broadcastStats();
        res.json({ success: true, id });
    } catch (e) {
        console.error("Admin Create Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await LocalDB.getAllUsers();
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- BACKGROUND TASKS ---

// Periodically expire stale transactions (Stuck in 'MANUAL_VERIFYING' for > 60s)
// This handles cases where the Admin App missed the transaction or looked it up but found nothing (and didn't report back yet)
setInterval(async () => {
    try {
        const cutoff = new Date(Date.now() - 60000).toISOString();
        const changes = await LocalDB.expireStaleTransactions(cutoff);
        if (changes > 0) {
            console.log(`[Cleanup] Expired ${changes} stale transactions.`);
            broadcastStats();
        }
    } catch (error) {
        console.error("[Cleanup] Error expiring transactions:", error);
    }
}, 10000); // Run every 10 seconds

// Schedule Daily Log Cleanup (Keep 7 days history)
setInterval(async () => {
    try {
        console.log('[Cleanup] Running Daily Prune...');
        const deleted = await LocalDB.pruneOldTransactions(7);
        if (deleted > 0) {
            console.log(`[Cleanup] Pruned ${deleted} old transactions.`);
            broadcastStats();
        }
    } catch (e) {
        console.error("[Cleanup] Prune failed:", e);
    }
}, 24 * 60 * 60 * 1000);

// Dashboard: Clear All Stats
app.post('/api/dashboard/clear-stats', async (req, res) => {
    try {
            const deleted = await LocalDB.clearAllStats();
            console.log(`[Dashboard] Cleared ${deleted} transactions`);
            res.json({ success: true, deleted });
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

server.listen(PORT, () => {
    console.log(`Secure Server running on port ${PORT}`);
});
