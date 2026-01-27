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

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const app = express();
const server = http.createServer(app);

// CORS Configuration: Allow all local IPs + env origins
const allowedOrigins = [
    process.env.FRONTEND_URL, 
    "http://localhost:5173", 
    "http://localhost:5174", 
    "http://localhost:4173",
    "http://localhost:3000",
    "http://localhost:3001",
    "https://report-labs.vercel.app",
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,  // Allow all 192.168.x.x:port
    /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,    // Allow all 10.x.x.x:port (other private networks)
    /^http:\/\/172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+:\d+$/  // Allow 172.16-31.x.x:port
].filter(Boolean);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Scoped connection tracking: { universityId: Set of socket IDs }
const connectionsByUniversity = new Map();
const socketToUniversity = new Map(); // Reverse lookup: socketId -> universityId

function getOnlineCount(universityId = null) {
    if (universityId) {
        return connectionsByUniversity.get(universityId)?.size || 0;
    }
    // Global count
    let total = 0;
    connectionsByUniversity.forEach(set => total += set.size);
    return total;
}

io.on('connection', (socket) => {
    // Client should send universitySlug in query or emit
    const universityId = socket.handshake.query.universityId || 'global';
    
    // Add to university-specific set
    if (!connectionsByUniversity.has(universityId)) {
        connectionsByUniversity.set(universityId, new Set());
    }
    connectionsByUniversity.get(universityId).add(socket.id);
    socketToUniversity.set(socket.id, universityId);
    
    const globalCount = getOnlineCount();
    const uniCount = getOnlineCount(universityId);
    console.log(`Client connected: ${socket.id} | Uni: ${universityId} | Uni Count: ${uniCount} | Global: ${globalCount}`);
    
    // Emit scoped count to this client
    socket.emit('online_count', { count: uniCount, globalCount, universityId });
    // Broadcast to all clients in same university room
    socket.join(`uni:${universityId}`);
    io.to(`uni:${universityId}`).emit('online_count', { count: uniCount, universityId });
    
    socket.on('disconnect', () => {
        const uni = socketToUniversity.get(socket.id) || 'global';
        connectionsByUniversity.get(uni)?.delete(socket.id);
        socketToUniversity.delete(socket.id);
        
        const newGlobalCount = getOnlineCount();
        const newUniCount = getOnlineCount(uni);
        console.log(`Client disconnected: ${socket.id} | Uni: ${uni} | Uni Count: ${newUniCount} | Global: ${newGlobalCount}`);
        
        io.to(`uni:${uni}`).emit('online_count', { count: newUniCount, universityId: uni });
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
app.use(express.static(path.join(__dirname, 'public')));

// CORS: Allow requests from frontend
app.use(cors({ 
    origin: function(origin, callback){
        if(!origin) return callback(null, true);
        if(allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')){
            return callback(null, true);
        }
        return callback(null, true);
    }
}));

// DEBUG: Log all requests
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.url} from ${req.ip}`);
    next();
});

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

let lastAppHeartbeat = 0;

// Initialize Local DB & Sync
(async () => {
    try {
        await LocalDB.init();
        if (db) {
            SyncService.start(db);
            
            const users = await LocalDB.getAllUsers();
            if (users.length === 0) {
                console.log('[Server] LocalDB Users empty. Attempting auto-hydration from Cloud...');
                await SyncService.hydrateUsers();
            }
            
            console.log('[Server] Checking if timetable hydration needed...');
            const timetableResult = await SyncService.hydrateTimetables();
            if (timetableResult.timetables > 0) {
                console.log(`[Server] Hydrated ${timetableResult.timetables} timetables from Cloud!`);
            }
        }
    } catch (e) {
        console.error("Failed to init LocalDB:", e);
    }
})();

// Helper: Broadcast Stats to Dashboard (Updated)
async function broadcastStats() {
    try {
        const stats = await LocalDB.getStats();
        // Add Userbase (Visits)
        const totalVisits = await LocalDB.getVisitorCount();
        
        const appConnected = (Date.now() - lastAppHeartbeat) < 30000;
        
        io.emit('stats_update', { 
            ...stats,
            visitorCount: totalVisits,
            onlineUsers: getOnlineCount(),
            appConnected 
        });
    } catch (e) {
        console.error("Broadcast Monitor Error:", e);
    }
}

// Track Visits Endpoint
app.post('/api/record-visit', async (req, res) => {
    try {
        const { uid, campusId, universityId } = req.body;
        console.log('[RecordVisit] Request:', { uid, campusId, universityId });
        
        if (!uid) {
            console.log('[RecordVisit] No UID provided, skipping');
            return res.json({ success: false, error: 'No UID' });
        }
        
        await LocalDB.recordVisit(uid, campusId, universityId);
        console.log('[RecordVisit] Success for UID:', uid);
        res.json({ success: true });
    } catch (e) {
        console.error("[RecordVisit] Error:", e.message);
        res.status(200).json({ success: false, error: e.message }); 
    }
});

// --- ADMIN IMPORT FEATURE ---
const multer = require('multer');
const { extractTextFromPDF, parseWithGemini } = require('./services/ai_extractor');

const upload = multer({ dest: 'uploads/' });

app.post('/api/admin/import-generic', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log(`[Admin Import] Processing ${req.file.originalname} using AI...`);
        const filePath = req.file.path;
        const fileBuffer = fs.readFileSync(filePath);

        // 1. Extract Text
        console.log('[Admin Import] Extracting text...');
        const rawText = await extractTextFromPDF(fileBuffer);
        
        // 2. AI Parsing
        console.log('[Admin Import] Identifying structure and extracting units...');
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("Server missing GEMINI_API_KEY");
        
        // Pass empty apiKey as it's handled internally now, but kept for signature if needed
        const result = await parseWithGemini(rawText, apiKey);
        
        // Cleanup
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            units: result.units,
            warnings: [] // AI could populate this eventually
        });

    } catch (error) {
        console.error('[Admin Import] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save Extracted Timetable
app.post('/api/admin/save-timetable', async (req, res) => {
    try {
        const { campusId, units } = req.body;
        if (!campusId || !units || !Array.isArray(units)) {
            return res.status(400).json({ error: 'Missing campusId or units array' });
        }

        console.log(`[Admin Import] Saving ${units.length} units for campus ${campusId}...`);
        const result = await LocalDB.saveTimetable(campusId, units);
        
        res.json({ success: true, count: result.count });
        
        // Broadcast Update?
        // Maybe notify clients on that campus?
        // For now, implicit via polling or manual refresh.

    } catch (error) {
        console.error('[Admin Import] Save Error:', error);
        res.status(500).json({ error: error.message });
    }
    
});

// --- PRESET START ---
app.get('/api/admin/presets', async (req, res) => {
    try {
        const { campusId } = req.query;
        if (!campusId) return res.status(400).json({ error: 'Missing campusId' });
        
        const presets = await LocalDB.getPresets(campusId);
        res.json(presets);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/save-preset', async (req, res) => {
    try {
        const { id, campusId, name, units, icon } = req.body;
        if (!id || !campusId || !name || !units) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        console.log(`[Presets] Saving preset ${name} for campus ${campusId}`);
        await LocalDB.savePreset({ id, campusId, name, units, icon });
        res.json({ success: true });
    } catch (e) {
        console.error('Preset Save Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/presets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await LocalDB.deletePreset(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// --- PRESET END ---


// --- METADATA ENDPOINTS (Universities & Campuses) ---

// Public endpoint for frontend to fetch all universities with hierarchy
app.get('/api/universities', async (req, res) => {
    try {
        const unis = await LocalDB.getUniversities();
        
        // Optionally enrich with hierarchy if requested
        if (req.query.includeHierarchy === 'true') {
            const enrichedUnis = await Promise.all(unis.map(async (uni) => {
                const campuses = await LocalDB.getCampuses(uni.id);
                
                // Build hierarchy for each campus
                const hierarchy = await Promise.all(campuses.map(async (campus) => {
                    const faculties = await LocalDB.getFaculties(campus.id);
                    
                    const children = await Promise.all(faculties.map(async (faculty) => {
                        const departments = await LocalDB.getDepartments(faculty.id);
                        
                        const deptChildren = await Promise.all(departments.map(async (dept) => {
                            const options = await LocalDB.getOptions(dept.id);
                            return {
                                slug: dept.slug,
                                name: dept.name,
                                subLabel: dept.subLabel,
                                children: options.map(o => ({ slug: o.slug, name: o.name }))
                            };
                        }));
                        
                        return {
                            slug: faculty.slug,
                            name: faculty.name,
                            subLabel: faculty.subLabel,
                            children: deptChildren.length > 0 ? deptChildren : undefined
                        };
                    }));
                    
                    return {
                        slug: campus.slug,
                        name: campus.name,
                        subLabel: campus.subLabel,
                        children: children.length > 0 ? children : undefined
                    };
                }));
                
                return {
                    ...uni,
                    campuses: campuses.map(c => c.slug),
                    hierarchy: hierarchy.length > 0 ? hierarchy : undefined,
                    defaultCampus: uni.defaultCampus || (campuses[0]?.slug)
                };
            }));
            
            return res.json(enrichedUnis);
        }
        
        res.json(unis);
    } catch (e) {
        console.error('[API] GET /api/universities error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- SEED ENDPOINTS (Local development only) ---
// These endpoints bypass authentication for seeding purposes
// Should be disabled in production

app.post('/api/seed/university', async (req, res) => {
    try {
        // Only allow in development
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Seed endpoints disabled in production' });
        }
        
        const { id, name, shortCode, slug, structureType, colors, tagline, faviconUrl, ogImageUrl, defaultCampus } = req.body;
        
        if (!id || !name || !shortCode) {
            return res.status(400).json({ error: 'Missing required fields: id, name, shortCode' });
        }
        
        // Check if already exists
        const existing = await LocalDB.getUniversity(id);
        if (existing) {
            return res.status(409).json({ error: 'University already exists', university: existing });
        }
        
        const university = await LocalDB.createUniversity({
            id,
            name,
            shortCode,
            slug: slug || shortCode.toLowerCase(),
            structureType: structureType || 'campus',
            colors,
            tagline,
            faviconUrl,
            ogImageUrl,
            defaultCampus
        });
        
        console.log(`[Seed] Created university: ${name} (${slug})`);
        res.json({ success: true, university });
    } catch (e) {
        console.error('[Seed University] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/seed/campus', async (req, res) => {
    try {
        // Only allow in development
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Seed endpoints disabled in production' });
        }
        
        const { universityId, name, slug } = req.body;
        
        if (!universityId || !name || !slug) {
            return res.status(400).json({ error: 'Missing required fields: universityId, name, slug' });
        }
        
        // Check if campus already exists
        const existingCampuses = await LocalDB.getCampuses(universityId);
        if (existingCampuses.some(c => c.slug === slug)) {
            return res.status(409).json({ error: 'Campus already exists' });
        }
        
        const campus = await LocalDB.createCampus({
            id: `campus_${slug}`,
            universityId,
            name,
            slug
        });
        
        console.log(`[Seed] Created campus: ${name} (${slug})`);
        res.json({ success: true, campus });
    } catch (e) {
        console.error('[Seed Campus] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/universities/:id/campuses', async (req, res) => {
    try {
        const { id } = req.params;
        // Correctly fetch campuses associated with the university from the campuses table
        const campuses = await LocalDB.db.all('SELECT * FROM campuses WHERE universityId = ?', [id]);
        
        // Return directly as the schema matches (id, name, slug)
        // Ensure we explicitly map if needed, but the DB columns likely match expectations
        res.json(campuses);
    } catch (e) {
        console.error('Fetch Campuses error', e);
        res.status(500).json({ error: e.message });
    }
});

// Manual Sync Trigger
app.post('/api/admin/sync-users', async (req, res) => {
    try {
        const count = await SyncService.hydrateUsers();
        res.json({ success: true, count });
    } catch (e) {
        console.error("Manual Sync Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// SYNC & DATA CLEANUP ENDPOINTS
// ============================================

/**
 * GET /api/admin/sync-status
 * Check pending sync items and orphaned Firestore records
 * Requires: requireAdmin
 */
app.get('/api/admin/sync-status', requireAdmin, async (req, res) => {
    try {
        // Get pending sync items
        const pendingItems = await LocalDB.getPendingSyncItems(1000);
        
        // Count deleted records (items with operation='delete')
        const deletedCount = pendingItems.filter(i => i.operation === 'delete').length;
        const pendingCount = pendingItems.length;
        
        // Analyze pending items by collection
        const byCollection = {};
        for (const item of pendingItems) {
            if (!byCollection[item.collection]) {
                byCollection[item.collection] = { create: 0, update: 0, delete: 0 };
            }
            byCollection[item.collection][item.operation]++;
        }

        res.json({
            success: true,
            pendingItems: pendingCount,
            deletedItemsPending: deletedCount,
            byCollection,
            lastItems: pendingItems.slice(0, 10) // Show first 10
        });
    } catch (e) {
        console.error('[Sync Status] Error:', e);
        res.status(500).json({ error: 'Failed to check sync status' });
    }
});

/**
 * POST /api/admin/sync-deletions-to-firebase
 * Queue all LocalDB deletions to sync with Firestore
 * Call this to sync-cleanup after deleting records in admin dashboard
 * Requires: requireAdmin + requireSuperAdmin (global scope change)
 */
app.post('/api/admin/sync-deletions-to-firebase', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        console.log('[Sync] Starting deletion sync to Firebase...');
        
        // Get all deleted items pending sync
        const deletedItems = await LocalDB.db.all(
            "SELECT * FROM sync_queue WHERE operation = 'delete' ORDER BY timestamp"
        );
        
        if (deletedItems.length === 0) {
            return res.json({ success: true, synced: 0, message: 'No pending deletions to sync' });
        }

        // Process each deletion
        let successCount = 0;
        const results = {
            synced: 0,
            failed: 0,
            details: []
        };

        for (const item of deletedItems) {
            try {
                const { collection, docId } = item;
                console.log(`[Sync] Deleting ${collection}/${docId} from Firebase...`);
                
                // Delete from Firestore
                await db.collection(collection).doc(docId).delete();
                
                results.details.push({
                    collection,
                    docId,
                    status: 'deleted'
                });
                successCount++;
            } catch (e) {
                console.error(`[Sync] Failed to delete ${item.collection}/${item.docId}:`, e.message);
                results.details.push({
                    collection: item.collection,
                    docId: item.docId,
                    status: 'failed',
                    error: e.message
                });
                results.failed++;
            }
        }

        // Remove synced items from queue
        const syncedIds = deletedItems.map(i => i.id);
        await LocalDB.removeSyncItems(syncedIds);

        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'sync_deletions',
            entityType: 'sync_queue',
            changesSummary: `Synced ${successCount} deletions to Firebase`,
            affectedCount: successCount
        });

        results.synced = successCount;
        res.json({
            success: true,
            ...results,
            message: `Synced ${successCount} deletions to Firebase${results.failed > 0 ? `, ${results.failed} failed` : ''}`
        });

    } catch (e) {
        console.error('[Sync Deletions] Error:', e);
        res.status(500).json({ error: 'Failed to sync deletions' });
    }
});

/**
 * POST /api/admin/sync-all-pending
 * Manually trigger sync of ALL pending items (create, update, delete)
 * This forces sync immediately instead of waiting for background loop
 * Requires: requireAdmin + requireSuperAdmin
 */
app.post('/api/admin/sync-all-pending', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        console.log('[Sync] Manual trigger of all pending items...');
        
        // Process through SyncService
        const before = await LocalDB.db.get("SELECT COUNT(*) as count FROM sync_queue");
        await SyncService.processQueue();
        const after = await LocalDB.db.get("SELECT COUNT(*) as count FROM sync_queue");

        const synced = (before?.count || 0) - (after?.count || 0);

        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'manual_sync_all',
            entityType: 'sync_queue',
            changesSummary: `Manually synced all pending items`,
            affectedCount: synced
        });

        res.json({
            success: true,
            synced,
            remaining: after?.count || 0,
            message: `Synced ${synced} items to Firebase`
        });

    } catch (e) {
        console.error('[Manual Sync All] Error:', e);
        res.status(500).json({ error: 'Failed to sync pending items' });
    }
});

/**
 * POST /api/admin/cleanup-orphaned-firestore
 * Find and delete orphaned records in Firestore (records not in LocalDB)
 * Requires: requireAdmin + requireSuperAdmin
 * WARNING: This is destructive, use with caution
 */
app.post('/api/admin/cleanup-orphaned-firestore', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { collection = 'timetables', dryRun = true } = req.body;
        
        console.log(`[Cleanup] ${dryRun ? 'DRY RUN' : 'LIVE'} - Finding orphaned records in ${collection}...`);
        
        // Get all docs from Firestore collection
        const firestoreDocs = await db.collection(collection).get();
        const orphaned = [];

        // Check each Firestore record against LocalDB
        for (const doc of firestoreDocs.docs) {
            let exists = false;
            
            if (collection === 'timetables') {
                exists = await LocalDB.getTimetable(doc.id);
            } else if (collection === 'users') {
                exists = await LocalDB.getUser(doc.id);
            } else if (collection === 'universities') {
                exists = await LocalDB.db.get('SELECT id FROM universities WHERE id = ?', doc.id);
            } else if (collection === 'campuses') {
                exists = await LocalDB.db.get('SELECT id FROM campuses WHERE id = ?', doc.id);
            } else if (collection === 'admins') {
                exists = await LocalDB.db.get('SELECT uid FROM admins WHERE uid = ?', doc.id);
            } else {
                // Generic check
                exists = await LocalDB.db.get(
                    `SELECT id FROM ${collection} WHERE id = ?`,
                    doc.id
                );
            }
            
            if (!exists) {
                orphaned.push({
                    id: doc.id,
                    data: doc.data()
                });
            }
        }

        if (orphaned.length === 0) {
            return res.json({
                success: true,
                dryRun,
                orphanedCount: 0,
                message: `No orphaned records found in ${collection}`
            });
        }

        console.log(`[Cleanup] Found ${orphaned.length} orphaned records in ${collection}`);

        // If not dry run, delete them
        let deletedCount = 0;
        if (!dryRun) {
            for (const record of orphaned) {
                try {
                    await db.collection(collection).doc(record.id).delete();
                    deletedCount++;
                    console.log(`[Cleanup] Deleted orphaned ${collection}/${record.id}`);
                } catch (e) {
                    console.error(`[Cleanup] Failed to delete ${collection}/${record.id}:`, e.message);
                }
            }

            // Audit log
            await LocalDB.createAuditLog({
                adminUid: req.adminUid,
                adminEmail: req.adminEmail,
                action: 'cleanup_orphaned',
                entityType: collection,
                changesSummary: `Deleted ${deletedCount} orphaned records from Firestore`,
                affectedCount: deletedCount
            });
        }

        res.json({
            success: true,
            dryRun,
            orphanedCount: orphaned.length,
            deletedCount: deletedCount,
            orphans: orphaned.slice(0, 20), // Show first 20
            message: dryRun 
                ? `Found ${orphaned.length} orphaned records. Run with dryRun=false to delete.`
                : `Deleted ${deletedCount} orphaned records from ${collection}`
        });

    } catch (e) {
        console.error('[Cleanup Orphaned] Error:', e);
        res.status(500).json({ error: 'Failed to cleanup orphaned records' });
    }
});

/**
 * GET /api/admin/sync-queue
 * View pending sync queue items
 * Requires: requireAdmin + requireSuperAdmin
 */
app.get('/api/admin/sync-queue', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const items = await LocalDB.getPendingSyncItems(parseInt(limit));
        
        res.json({
            success: true,
            total: items.length,
            items
        });
    } catch (e) {
        console.error('[Sync Queue] Error:', e);
        res.status(500).json({ error: 'Failed to get sync queue' });
    }
});

// Lipana Config
const LIPANA_BASE_URL = 'https://api.lipana.dev/v1';

// lastAppHeartbeat is declared earlier in file

// Plans (Sync with frontend if needed, but validation happens here)
const PLANS = {
    'starter': { credits: 3, price: 10 },
    'pro': { credits: 19, price: 29 },
    'unlimited': { credits: 9999, price: 99, durationDays: 30 },
    'BASIC_LABS': { credits: 0, price: 39, name: 'Report Labs' },
    'REPORT_LABS': { credits: 0, price: 39, name: 'Report Labs' }
};

// Auto-Payout Configuration
const AUTO_PAYOUT_ENABLED = process.env.AUTO_PAYOUT_ENABLED === 'true';
const PAYOUT_PHONE = process.env.PAYOUT_PHONE || ''; // Your M-Pesa number to receive payouts

/**
 * Auto-withdraw payment to owner's M-Pesa after successful transaction
 * Uses Lipana's sendToPhone API
 */
async function autoPayoutToOwner(amount, transactionId) {
    if (!AUTO_PAYOUT_ENABLED) {
        console.log(`[Payout] Auto-payout disabled. Skipping withdrawal.`);
        return { success: false, reason: 'disabled' };
    }
    
    if (!PAYOUT_PHONE) {
        console.log(`[Payout] No PAYOUT_PHONE configured. Skipping withdrawal.`);
        return { success: false, reason: 'no_phone' };
    }
    
    const API_KEY = process.env.LIPANA_SECRET_KEY;
    if (!API_KEY) {
        console.log(`[Payout] No LIPANA_SECRET_KEY. Skipping withdrawal.`);
        return { success: false, reason: 'no_api_key' };
    }
    
    try {
        // Normalize phone format
        let phone = PAYOUT_PHONE.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
        if (phone.startsWith('0')) {
            phone = '254' + phone.substring(1);
        } else if (phone.startsWith('+')) {
            phone = phone.substring(1);
        }
        
        console.log(`[Payout] Initiating auto-withdrawal of ${amount} KES to ${phone}`);
        
        // Call Lipana Payout API
        const response = await axios.post(
            `${LIPANA_BASE_URL}/payouts/send-to-phone`,
            { phone, amount },
            { headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' } }
        );
        
        console.log(`[Payout] ✅ Withdrawal initiated:`, response.data);
        return { success: true, data: response.data };
        
    } catch (error) {
        // Log but don't fail the main flow
        if (error.response) {
            console.error(`[Payout] ❌ Failed:`, {
                status: error.response.status,
                data: error.response.data
            });
        } else {
            console.error(`[Payout] ❌ Failed:`, error.message);
        }
        return { success: false, error: error.message };
    }
}

app.get('/', (req, res) => {
    res.send('UoN Smart Timetable Secure Backend 🛡️');
});

// 1. Initiate Payment
app.post('/api/pay', async (req, res) => {
    const { phone, planId, uid, campusId, universityId } = req.body;

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
            // Normalize phone number format for Lipana (expects 254xxxxxxxxx)
            let formattedPhone = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
            if (formattedPhone.startsWith('0')) {
                formattedPhone = '254' + formattedPhone.substring(1);
            } else if (formattedPhone.startsWith('+')) {
                formattedPhone = formattedPhone.substring(1);
            }
            
            console.log(`[Pay] Calling Lipana STK Push: phone=${formattedPhone}, amount=${plan.price}`);
            
            // REAL MODE: Call Lipana
             response = await axios.post(
                `${LIPANA_BASE_URL}/transactions/push-stk`,
                { phone: formattedPhone, amount: plan.price },
                { headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' } }
            );
            
            console.log(`[Pay] Lipana Response:`, JSON.stringify(response.data, null, 2));
            
            // Try multiple response formats Lipana might use
            checkoutReqId = response.data.data?.checkoutRequestID || 
                           response.data.checkoutRequestID ||
                           response.data.data?.transactionId ||
                           response.data.transactionId;
        }


        if (!checkoutReqId) throw new Error("No transactionId from Lipana");

        // Save Transaction Locally (Syncs to Cloud automatically)
        await LocalDB.createTransaction({
            id: checkoutReqId,
            uid,
            planId,
            amount: plan.price,
            phone,
            status: 'PENDING',
            type: 'STK',
            createdAt: new Date().toISOString(),
            campusId,
            universityId
        });

        console.log(`[Pay] Transaction saved: ${checkoutReqId}`);

        res.json({ 
            success: true, 
            message: "STK Push Sent",
            transactionId: checkoutReqId
        });

        // Broadcast Stats Update
        broadcastStats();


    } catch (error) {
        // Log detailed Lipana error response
        if (error.response) {
            console.error("Payment Init Error - Lipana Response:", {
                status: error.response.status,
                data: error.response.data
            });
        } else {
            console.error("Payment Init Error:", error.message);
        }
        res.status(500).json({ error: error.response?.data?.message || 'Payment initiation failed' });
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
// 2. Webhook Callback (Lipana sends payment status updates here)

// 2. Webhook Callback
app.post('/api/callback', async (req, res) => {
    try {
        // Lipana webhook format: { event: "payment.success", data: { transactionId, status, ... } }
        // Also support legacy format: { checkoutRequestID, status }
        const body = req.body;
        
        // Extract transaction ID (support both formats)
        // Lipana uses 'transaction_id' in data object
        const transactionId = body.data?.transaction_id || body.data?.transactionId || body.transactionId || body.checkoutRequestID;
        const status = body.data?.status || body.status;
        const event = body.event; // e.g., "payment.success", "payment.failed", "transaction.success"
        
        console.log(`[Webhook] Received:`, JSON.stringify(body, null, 2));
        console.log(`[Webhook] TransactionId: ${transactionId}, Status: ${status}, Event: ${event}`);

        if (!transactionId) {
            console.error("[Webhook] Missing transactionId");
            return res.sendStatus(400);
        }

        const txn = await LocalDB.getTransaction(transactionId);
        if (!txn) {
            console.error("Transaction not found:", transactionId);
            return res.sendStatus(404);
        }

        if (txn.status === 'COMPLETED') {
            console.log(`[Webhook] Transaction ${transactionId} already completed`);
            return res.sendStatus(200);
        }

        // Check for success (Lipana uses "success" or event "payment.success" or "transaction.success")
        const isSuccess = status === 'success' || status === 'Success' || status === 'Completed' || event === 'payment.success' || event === 'transaction.success';
        const isFailed = status === 'failed' || status === 'Failed' || event === 'payment.failed';

        if (isSuccess) {
            const plan = PLANS[txn.planId];
            
            // Fulfill Credits & Update Status
            await LocalDB.updateUserCredits(
                txn.uid, 
                plan.credits, 
                txn.planId === 'unlimited', 
                transactionId
            );

            await LocalDB.updateTransactionStatus(transactionId, 'COMPLETED', {
                verifiedAt: new Date().toISOString()
            });
            
            console.log(`[Webhook] ✅ User ${txn.uid} credited with ${plan.credits} credits.`);
            
            // Auto-withdraw to owner's M-Pesa if enabled
            if (txn.amount && txn.amount > 0) {
                autoPayoutToOwner(txn.amount, transactionId);
            }
            
            // Broadcast to connected dashboards
            broadcastStats();
        } else if (isFailed) {
            await LocalDB.updateTransactionStatus(transactionId, 'FAILED', {
                failedAt: new Date().toISOString()
            });
            console.log(`[Webhook] ❌ Transaction ${transactionId} failed.`);
        } else {
            console.log(`[Webhook] Unknown status for ${transactionId}: ${status}`);
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
    const { code, planId, uid, phone, campusId, universityId } = req.body;

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
            createdAt: new Date().toISOString(),
            campusId,
            universityId
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
    // Check if Lipana secret key exists (used for STK Push)
    const hasKey = !!process.env.LIPANA_SECRET_KEY;
    const isMock = process.env.LIPANA_SECRET_KEY === 'lip_sk_test_mock_key';
    const isDev = process.env.NODE_ENV !== 'production';
    
    // Enable STK if we have a real Lipana key (not mock, unless in dev)
    let stkEnabled = hasKey && (!isMock || isDev);

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
    const wasConnected = (Date.now() - lastAppHeartbeat) < 30000;
    lastAppHeartbeat = Date.now(); // Update heartbeat
    
    // IF it was offline and now pinged -> It's back ONLINE. Broadcast immediately.
    if (!wasConnected) {
        console.log("[Device] Reconnected!");
        broadcastStats();
    }

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

// Heartbeat Monitor (Check for Disconnects)
setInterval(() => {
    const isConnected = (Date.now() - lastAppHeartbeat) < 30000;
    // We need to track previous state to know if it CHANGED. 
    // Using a simple global var for this loop might be cleaner? 
    // Actually, let's just use the helper since broadcast sends the current state.
    // Ideally we only broadcast if changed.
    // Let's rely on the fact that if it's > 30s, we want to ensure UI knows.
    // To avoid spamming, we can check a global `lastBroadcastState`?
    // Start simpler: run every 10s. If we think it's disconnected, broadcast.
    // Client-side handles idempotent updates fine.
    
    // Better:
    // If (now - lastHeartbeat) is barely over 30s (e.g. < 40s), it implies it JUST disconnected.
    const timeSince = Date.now() - lastAppHeartbeat;
    if (timeSince > 30000 && timeSince < 40000) {
         console.log("[Device] Connection Lost (Timeout)");
         broadcastStats();
    }
}, 5000);

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


// Admin: Edit User Credits Manually
app.post('/api/admin/users/:uid/credits', async (req, res) => {
    const { uid } = req.params;
    const { credits, isUnlimited } = req.body;

    if (!uid || credits === undefined) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        // We use updateUserCredits but we need to calculate 'creditsToAdd' difference or just force set?
        // Existing method is `updateUserCredits(uid, creditsToAdd, isUnlimited, txnRef)` which ADDS.
        // We want to SET.
        // Let's modify LocalDB or just calculate diff? 
        // Diff is safer with existing method but prone to race conditions if not careful.
        // Better: Add a `setUserCredits` method or reuse `importUser` which does SET/Update?
        // `importUser` does SET. Let's use that! simpler.
        // But `importUser` expects full object.
        
        // Let's just fetch, calc diff, and use update?
        // Or better: Implement a specific SET method in LocalDB for clarity?
        // Actually, `importUser` calls UPDATE ... SET credits = ?. That IS a set.
        // But we need to preserve other fields.
        
        const user = await LocalDB.getUser(uid);
        const currentRef = user ? user.lastPaymentRef : 'ADMIN_EDIT';
        const currentEmail = user ? user.email : null;
        const currentReset = user ? user.lastDailyReset : null;

        await LocalDB.importUser({
            uid,
            email: currentEmail,
            credits: parseInt(credits),
            unlimitedExpiresAt: isUnlimited ? new Date(Date.now() + 30*24*60*60*1000).toISOString() : null, // 30 days if setting unlimited
            lastDailyReset: currentReset,
            lastPaymentRef: 'ADMIN_MANUAL'
        });

        // Trigger Broadcast
        broadcastStats();
        
        // Also queue sync? importUser does NOT queue sync!
        // We MUST queue sync for this change to propagate to Cloud.
        await LocalDB.addToSyncQueue('users', uid, 'update', { 
            credits: parseInt(credits),
            unlimitedExpiresAt: isUnlimited ? new Date(Date.now() + 30*24*60*60*1000).toISOString() : null,
            lastPaymentRef: 'ADMIN_MANUAL'
        });

        res.json({ success: true });
    } catch (e) {
        console.error("Admin Edit User Error:", e);
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
            
            await LocalDB.updateUserCredits(uid, -1, false, 'CONSUME'); 

            console.log(`[Backend] Consumed 1 credit for ${uid}. New Balance: ${newCredits}`);
            
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
    const visitorCount = await LocalDB.getVisitorCount();
    return { 
        ...stats, 
        isPhoneConnected: isConnected,
        visitorCount,
        onlineUsers: getOnlineCount()
    };
}

// Function to broadcast stats to connected clients
async function broadcastStats() {
    try {
        const stats = await LocalDB.getStats();
        const appConnected = (Date.now() - lastAppHeartbeat) < 30000; // 30s timeout for app connection
        
        io.emit('stats_update', { 
            ...stats,
            appConnected 
        });
    } catch (e) {
        console.error("Broadcast Error:", e);
    }
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
            campusId: data.campusId,
            universityId: data.universityId,
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

// ============================================
// ADMIN SYSTEM API ROUTES
// ============================================

// Admin Auth Middleware
async function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    
    const token = authHeader.split('Bearer ')[1];
    
    try {
        // Verify Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        const email = decodedToken.email;
        
        // Check if user is admin
        let adminUser = await LocalDB.getAdmin(uid);
        
        // Also check by email (for initial super admin setup)
        if (!adminUser && email) {
            adminUser = await LocalDB.getAdminByEmail(email);
            if (adminUser && adminUser.uid !== uid) {
                // Update admin UID from Firebase
                await LocalDB.db.run('UPDATE admins SET uid = ? WHERE email = ?', [uid, email]);
                adminUser.uid = uid;
            }
        }
        
        if (!adminUser) {
            return res.status(403).json({ error: 'Forbidden: Not an admin' });
        }
        
        req.admin = adminUser;
        req.adminUid = uid;
        req.adminEmail = email;
        next();
    } catch (error) {
        console.error('[Admin Auth] Error:', error.message);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
}

// Super Admin Only Middleware
function requireSuperAdmin(req, res, next) {
    if (req.admin.role !== 'super') {
        return res.status(403).json({ error: 'Forbidden: Super admin access required' });
    }
    next();
}

// Scope Check Middleware
// Secure Scope Middleware
async function enforceScope(req, res, next) {
    if (req.admin.role === 'super' || req.admin.scope === '*') return next();

    let targetCampusId = req.body.campusId;

    // For updates/deletes by ID - lookup campusId
    if (!targetCampusId && req.params.id && (req.method === 'PUT' || req.method === 'DELETE')) {
        try {
            const item = await LocalDB.db.get('SELECT campusId FROM timetables WHERE id = ?', [req.params.id]);
            if (item) targetCampusId = item.campusId;
        } catch (e) {
            console.error('[Scope Check] DB Error:', e);
            return res.status(500).json({ error: 'Security check failed' }); 
        }
    }
    
    // For Bulk Update/Delete (Check first item heuristic)
    if (!targetCampusId && req.body.updates && Array.isArray(req.body.updates) && req.body.updates.length > 0) {
        targetCampusId = req.body.updates[0].campusId;
    }
    if (!targetCampusId && req.body.ids && Array.isArray(req.body.ids) && req.body.ids.length > 0) {
        // Bulk delete... hard to verify all without query. 
        // For now, strict: Requires campusId in body for bulk delete scope verification?
        // Or assume bulk delete sends campusId.
        if (req.body.campusId) targetCampusId = req.body.campusId; 
    }

    if (!targetCampusId) return next();

    const [scopeType, scopeId] = req.admin.scope.split(':');
    
    // CAMPUS SCOPE CHECK
    if (scopeType === 'campus' && scopeId !== targetCampusId) {
        return res.status(403).json({ error: `Forbidden: You can only manage ${scopeId}` });
    }
    
    // UNIVERSITY SCOPE CHECK
    if (scopeType === 'university') {
         const campus = await LocalDB.db.get('SELECT universityId FROM campuses WHERE id = ?', [targetCampusId]);
         if (!campus || campus.universityId !== scopeId) {
             return res.status(403).json({ error: `Forbidden: You only manage university ${scopeId}` });
         }
    }

    next();
}

// --- PUBLIC TIMETABLE ENDPOINTS ---

// Get campus data version (for smart caching)
app.get('/api/timetable/version/:campusSlug', async (req, res) => {
    try {
        const { campusSlug } = req.params;
        const version = await LocalDB.getCampusVersion(campusSlug);
        if (!version) {
            return res.status(404).json({ error: 'Campus not found' });
        }
        res.json(version);
    } catch (e) {
        console.error('[Timetable Version] Error:', e);
        res.status(500).json({ error: 'Failed to get version' });
    }
});

// Get timetable data for a campus
app.get('/api/timetable/:campusSlug', async (req, res) => {
    try {
        const { campusSlug } = req.params;
        const timetables = await LocalDB.getTimetablesByCampusSlug(campusSlug);
        const version = await LocalDB.getCampusVersion(campusSlug);
        
        res.json({
            data: timetables,
            version: version?.version || 1,
            count: timetables.length
        });
    } catch (e) {
        console.error('[Timetable Get] Error:', e);
        res.status(500).json({ error: 'Failed to get timetables' });
    }
});

// Get universities list
app.get('/api/universities', async (req, res) => {
    try {
        const universities = await LocalDB.getUniversities();
        res.json(universities);
    } catch (e) {
        console.error('[Universities] Error:', e);
        res.status(500).json({ error: 'Failed to get universities' });
    }
});

// Get campuses for a university
app.get('/api/universities/:id/campuses', async (req, res) => {
    try {
        const { id } = req.params;
        const campuses = await LocalDB.getCampuses(id);
        res.json(campuses);
    } catch (e) {
        console.error('[Campuses] Error:', e);
        res.status(500).json({ error: 'Failed to get campuses' });
    }
});

// Get faculties for a campus
app.get('/api/campuses/:id/faculties', async (req, res) => {
    try {
        const { id } = req.params;
        const faculties = await LocalDB.getFaculties(id);
        res.json(faculties);
    } catch (e) {
        console.error('[Faculties] Error:', e);
        res.status(500).json({ error: 'Failed to get faculties' });
    }
});

// --- ADMIN TIMETABLE CRUD ---

// Get admin info
app.get('/api/admin/me', requireAdmin, async (req, res) => {
    try {
        const unreadMessages = await LocalDB.getUnreadCount(req.adminUid);
        res.json({
            ...req.admin,
            unreadMessages
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get admin info' });
    }
});

// Get timetable stats
app.get('/api/admin/timetable/stats', requireAdmin, async (req, res) => {
    try {
        let { campusId, universityId } = req.query;
        
        // Scope Check (Read)
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
            const [scopeType, scopeId] = req.admin.scope.split(':');
            if (scopeType === 'campus') {
                campusId = scopeId;
                universityId = null; // Enforce campus scope
            } else if (scopeType === 'university') {
                // If they requested a specific campus, verify it belongs
                if (campusId) {
                     // DB check done inside DB or we can check here.
                     // DB getTimetableStats(campusId) doesn't check uni ownership implicitly unless we pass both?
                     // Actually, if I pass ONLY campusId, DB doesn't check uni.
                     // Security: I should verify ownership if scope is university.
                     const campus = await LocalDB.db.get('SELECT universityId FROM campuses WHERE id = ?', [campusId]);
                     if (!campus || campus.universityId !== scopeId) {
                         return res.status(403).json({ error: 'Access denied to this campus' });
                     }
                } else {
                    // No specific campus, execute stats for THEIR university
                    universityId = scopeId;
                }
            }
        }
        
        const stats = await LocalDB.getTimetableStats(campusId || null, universityId || null);
        const visitorCount = await LocalDB.getVisitorCount(campusId || null, universityId || null);
        // Get scoped online count based on admin's scope
        const onlineUsers = (req.admin.role === 'super' || req.admin.scope === '*') 
            ? getOnlineCount() 
            : getOnlineCount(universityId);
        res.json({ ...stats, visitorCount, onlineUsers });
    } catch (e) {
        console.error('[Admin Timetable Stats] Error:', e);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Search timetables
app.get('/api/admin/timetable/search', requireAdmin, async (req, res) => {
    try {
        let { q, campusId, universityId, facultyId, departmentId, optionId } = req.query;
        
        // Scope Check (Read)
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
            const [scopeType, scopeId] = req.admin.scope.split(':');
            if (scopeType === 'campus') {
                campusId = scopeId;
            } else if (scopeType === 'university') {
                universityId = scopeId; 
                // Note: If they passed campusId, we trust it (or validate it belongs to this uni if strict)
                // For search, we can allow them to search their whole uni OR a specific campus.
                // If they passed campusId, we use it. If not, we use universityId.
            }
        }

        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        const results = await LocalDB.searchTimetables(
            q, 
            campusId || null, 
            universityId || null,
            facultyId || null,
            departmentId || null,
            optionId || null
        );
        res.json(results);
    } catch (e) {
        console.error('[Admin Search] Error:', e);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Create timetable entry
app.post('/api/admin/timetable', requireAdmin, enforceScope, async (req, res) => {
    try {
        const data = req.body;
        const id = `tt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const entry = await LocalDB.createTimetable({ ...data, id }, req.adminUid);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'create',
            entityType: 'timetable',
            entityId: id,
            changesSummary: { code: data.code, title: data.title }
        });
        
        res.json({ success: true, entry });
    } catch (e) {
        console.error('[Admin Create Timetable] Error:', e);
        res.status(500).json({ error: 'Failed to create entry' });
    }
});

// Update timetable entry
app.put('/api/admin/timetable/:id', requireAdmin, enforceScope, async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        
        const entry = await LocalDB.updateTimetable(id, data, req.adminUid);
        
        if (!entry) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'update',
            entityType: 'timetable',
            entityId: id,
            changesSummary: data
        });
        
        res.json({ success: true, entry });
    } catch (e) {
        console.error('[Admin Update Timetable] Error:', e);
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

// Delete timetable entry
app.delete('/api/admin/timetable/:id', requireAdmin, enforceScope, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await LocalDB.getTimetable(id);
        
        const deleted = await LocalDB.deleteTimetable(id);
        
        if (deleted === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'delete',
            entityType: 'timetable',
            entityId: id,
            changesSummary: { code: existing?.code }
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Admin Delete Timetable] Error:', e);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

// Bulk update timetables
app.post('/api/admin/timetable/bulk-update', requireAdmin, enforceScope, async (req, res) => {
    try {
        const { ids, changes } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }
        
        const updated = await LocalDB.bulkUpdateTimetables(ids, changes, req.adminUid);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'bulk_update',
            entityType: 'timetable',
            changesSummary: changes,
            affectedCount: updated
        });
        
        res.json({ success: true, updated });
    } catch (e) {
        console.error('[Admin Bulk Update] Error:', e);
        res.status(500).json({ error: 'Bulk update failed' });
    }
});

// Bulk delete timetables
app.post('/api/admin/timetable/bulk-delete', requireAdmin, enforceScope, async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }
        
        const deleted = await LocalDB.bulkDeleteTimetables(ids);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'bulk_delete',
            entityType: 'timetable',
            affectedCount: deleted
        });
        
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('[Admin Bulk Delete] Error:', e);
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// Import timetables
app.post('/api/admin/timetable/import', requireAdmin, enforceScope, async (req, res) => {
    try {
        const { campusId, entries } = req.body;
        
        if (!campusId || !entries || !Array.isArray(entries)) {
            return res.status(400).json({ error: 'Invalid import data' });
        }
        
        const imported = await LocalDB.importTimetables(campusId, entries, req.adminUid);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'import',
            entityType: 'timetable',
            changesSummary: { campusId },
            affectedCount: imported
        });
        
        res.json({ success: true, imported });
    } catch (e) {
        console.error('[Admin Import] Error:', e);
        res.status(500).json({ error: 'Import failed' });
    }
});

// --- EXPORT ---

app.get('/api/admin/export/:campusSlug', requireAdmin, async (req, res) => {
    try {
        const { campusSlug } = req.params;
        const { format } = req.query;
        
        const timetables = await LocalDB.getTimetablesByCampusSlug(campusSlug);
        
        if (format === 'csv') {
            // CSV Export
            const headers = 'code,title,date,time,venue,level,semester\n';
            const rows = timetables.map(t => 
                `"${t.code}","${t.title || ''}","${t.date}","${t.time}","${t.venue || ''}",${t.level || ''},${t.semester || ''}`
            ).join('\n');
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${campusSlug}_timetable.csv`);
            res.send(headers + rows);
        } else {
            // JSON Export (default)
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=${campusSlug}_timetable.json`);
            res.json(timetables);
        }
    } catch (e) {
        console.error('[Admin Export] Error:', e);
        res.status(500).json({ error: 'Export failed' });
    }
});

// --- FACULTY MANAGEMENT ---

app.post('/api/admin/faculties', requireAdmin, async (req, res) => {
    try {
        const { campusId, name, slug } = req.body;
        const id = `fac_${Date.now()}`;
        
        const faculty = await LocalDB.createFaculty({ id, campusId, name, slug });
        res.json({ success: true, faculty });
    } catch (e) {
        console.error('[Admin Create Faculty] Error:', e);
        res.status(500).json({ error: 'Failed to create faculty' });
    }
});

app.put('/api/admin/faculties/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug } = req.body;
        
        const faculty = await LocalDB.updateFaculty(id, { name, slug });
        res.json({ success: true, faculty });
    } catch (e) {
        console.error('[Admin Update Faculty] Error:', e);
        res.status(500).json({ error: 'Failed to update faculty' });
    }
});

app.delete('/api/admin/faculties/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await LocalDB.deleteFaculty(id);
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('[Admin Delete Faculty] Error:', e);
        res.status(500).json({ error: 'Failed to delete faculty' });
    }
});

// --- DEPARTMENT MANAGEMENT ---

app.get('/api/admin/departments', requireAdmin, async (req, res) => {
    try {
        const { facultyId } = req.query;
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID required' });
        
        const departments = await LocalDB.getDepartments(facultyId);
        res.json(departments);
    } catch (e) {
        console.error('[Admin List Departments] Error:', e);
        res.status(500).json({ error: 'Failed to get departments' });
    }
});

app.post('/api/admin/departments', requireAdmin, async (req, res) => {
    try {
        const { facultyId, name, slug, subLabel } = req.body;
        const id = `dept_${Date.now()}`;
        
        const department = await LocalDB.createDepartment({ id, facultyId, name, slug, subLabel });
        res.json({ success: true, department });
    } catch (e) {
        console.error('[Admin Create Department] Error:', e);
        res.status(500).json({ error: 'Failed to create department' });
    }
});

app.put('/api/admin/departments/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug, subLabel } = req.body;
        
        const department = await LocalDB.updateDepartment(id, { name, slug, subLabel });
        res.json({ success: true, department });
    } catch (e) {
        console.error('[Admin Update Department] Error:', e);
        res.status(500).json({ error: 'Failed to update department' });
    }
});

app.delete('/api/admin/departments/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await LocalDB.deleteDepartment(id);
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('[Admin Delete Department] Error:', e);
        res.status(500).json({ error: 'Failed to delete department' });
    }
});

// --- OPTION MANAGEMENT ---

app.get('/api/admin/options', requireAdmin, async (req, res) => {
    try {
        const { departmentId } = req.query;
        if (!departmentId) return res.status(400).json({ error: 'Department ID required' });
        
        const options = await LocalDB.getOptions(departmentId);
        res.json(options);
    } catch (e) {
        console.error('[Admin List Options] Error:', e);
        res.status(500).json({ error: 'Failed to get options' });
    }
});

app.post('/api/admin/options', requireAdmin, async (req, res) => {
    try {
        const { departmentId, name, slug } = req.body;
        const id = `opt_${Date.now()}`;
        
        const option = await LocalDB.createOption({ id, departmentId, name, slug });
        res.json({ success: true, option });
    } catch (e) {
        console.error('[Admin Create Option] Error:', e);
        res.status(500).json({ error: 'Failed to create option' });
    }
});

app.put('/api/admin/options/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug } = req.body;
        
        const option = await LocalDB.updateOption(id, { name, slug });
        res.json({ success: true, option });
    } catch (e) {
        console.error('[Admin Update Option] Error:', e);
        res.status(500).json({ error: 'Failed to update option' });
    }
});

app.delete('/api/admin/options/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await LocalDB.deleteOption(id);
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('[Admin Delete Option] Error:', e);
        res.status(500).json({ error: 'Failed to delete option' });
    }
});

// --- ADMIN MANAGEMENT (Super Admin Only) ---

app.get('/api/admin/admins', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const admins = await LocalDB.getAdmins();
        res.json(admins);
    } catch (e) {
        console.error('[Admin List] Error:', e);
        res.status(500).json({ error: 'Failed to get admins' });
    }
});

app.post('/api/admin/admins', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { email, role, scope } = req.body;
        
        if (!email || !scope) {
            return res.status(400).json({ error: 'Email and scope required' });
        }
        
        // Generate placeholder UID (will be updated on first login)
        const uid = `pending_${Date.now()}`;
        
        const adminUser = await LocalDB.createAdmin({ uid, email, role: role || 'editor', scope }, req.adminUid);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'create',
            entityType: 'admin',
            changesSummary: { email, role, scope }
        });
        
        res.json({ success: true, admin: adminUser });
    } catch (e) {
        console.error('[Admin Create] Error:', e);
        res.status(500).json({ error: 'Failed to create admin' });
    }
});

app.put('/api/admin/admins/:uid', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { uid } = req.params;
        const { role, scope } = req.body;
        
        const updated = await LocalDB.updateAdmin(uid, { role, scope });
        res.json({ success: true, admin: updated });
    } catch (e) {
        console.error('[Admin Update] Error:', e);
        res.status(500).json({ error: 'Failed to update admin' });
    }
});

app.delete('/api/admin/admins/:uid', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { uid } = req.params;
        
        if (uid === req.adminUid) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        
        const deleted = await LocalDB.deleteAdmin(uid);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'delete',
            entityType: 'admin',
            entityId: uid
        });
        
        res.json({ success: true, deleted });
    } catch (e) {
        console.error('[Admin Delete] Error:', e);
        res.status(500).json({ error: 'Failed to delete admin' });
    }
});

// --- MESSAGING ---

app.get('/api/admin/messages', requireAdmin, async (req, res) => {
    try {
        const { unreadOnly } = req.query;
        const messages = await LocalDB.getMessages(req.adminUid, unreadOnly === 'true');
        res.json(messages);
    } catch (e) {
        console.error('[Messages Get] Error:', e);
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

app.post('/api/admin/messages', requireAdmin, async (req, res) => {
    try {
        const { toUid, subject, body } = req.body;
        
        // Only super admin can send to all (toUid = null)
        if (!toUid && req.admin.role !== 'super') {
            return res.status(403).json({ error: 'Only super admin can broadcast' });
        }
        
        const message = await LocalDB.createMessage({
            fromUid: req.adminUid,
            toUid,
            subject,
            body
        });
        
        res.json({ success: true, message });
    } catch (e) {
        console.error('[Message Create] Error:', e);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.put('/api/admin/messages/:id/read', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await LocalDB.markMessageRead(id, req.adminUid);
        res.json({ success: true });
    } catch (e) {
        console.error('[Message Read] Error:', e);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// --- AUDIT LOGS ---

app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
    try {
        const { limit, offset, adminUid, action, entityType } = req.query;
        
        // Non-super admins can only see their own logs
        const filters = req.admin.role === 'super' 
            ? { adminUid, action, entityType }
            : { adminUid: req.adminUid, action, entityType };
        
        const logs = await LocalDB.getAuditLogs(
            parseInt(limit) || 100,
            parseInt(offset) || 0,
            filters
        );
        
        res.json(logs);
    } catch (e) {
        console.error('[Audit Logs] Error:', e);
        res.status(500).json({ error: 'Failed to get audit logs' });
    }
});

// --- REVENUE & COMMISSIONS ---

// Get revenue config (super admin only)
app.get('/api/admin/revenue-config', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const config = await LocalDB.getRevenueConfig();
        res.json(config);
    } catch (e) {
        console.error('[Revenue Config] Error:', e);
        res.status(500).json({ error: 'Failed to get revenue config' });
    }
});

// Update revenue config (super admin only)
app.put('/api/admin/revenue-config', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { super_admin_cut, admin_cut } = req.body;
        
        if (typeof super_admin_cut !== 'number' || typeof admin_cut !== 'number') {
            return res.status(400).json({ error: 'Invalid cut percentages' });
        }
        
        if (super_admin_cut + admin_cut !== 100) {
            return res.status(400).json({ error: 'Cuts must total 100%' });
        }
        
        const config = await LocalDB.updateRevenueConfig(super_admin_cut, admin_cut, req.admin.email);
        
        // Audit log
        await LocalDB.addAuditLog(req.adminUid, req.admin.email, 'update_revenue_config', 
            'revenue_config', '1', JSON.stringify({ super_admin_cut, admin_cut }), 1);
        
        res.json(config);
    } catch (e) {
        console.error('[Revenue Config] Error:', e);
        res.status(500).json({ error: 'Failed to update revenue config' });
    }
});

// Set custom cut for specific admin (super admin only)
app.put('/api/admin/admins/:uid/custom-cut', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { uid } = req.params;
        const { custom_cut } = req.body; // null = use global, number = custom percentage
        
        await LocalDB.setAdminCustomCut(uid, custom_cut, req.adminUid);
        res.json({ success: true, custom_cut });
    } catch (e) {
        console.error('[Custom Cut] Error:', e);
        res.status(500).json({ error: 'Failed to set custom cut' });
    }
});

// Revenue endpoint - now accessible to all admins with proper scoping
app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
    try {
        let { universityId, campusId } = req.query;
        const isSuperAdmin = req.admin.role === 'super';
        
        // Scope enforcement for non-super admins
        if (!isSuperAdmin && req.admin.scope !== '*') {
            const [scopeType, scopeId] = req.admin.scope.split(':');
            if (scopeType === 'campus') {
                campusId = scopeId;
                universityId = null;
            } else if (scopeType === 'university') {
                universityId = scopeId;
                if (campusId) {
                    // Verify campus belongs to their university
                    const campus = await LocalDB.db.get('SELECT universityId FROM campuses WHERE id = ?', [campusId]);
                    if (!campus || campus.universityId !== scopeId) {
                        return res.status(403).json({ error: 'Access denied' });
                    }
                }
            }
        }
        
        // Get revenue with splits
        const revenue = await LocalDB.getRevenueWithSplits(
            campusId || null, 
            universityId || null, 
            isSuperAdmin ? null : req.adminUid
        );
        
        // Get breakdown by campus (scoped)
        // Pass universityId/campusId to filter the list
        const byCampus = await LocalDB.getRevenueByCampus(
            universityId || null,
            campusId || null
        );
        
        res.json({ 
            ...revenue,
            byCampus,
            isSuperAdmin
        });
    } catch (e) {
        console.error('[Revenue] Error:', e);
        res.status(500).json({ error: 'Failed to get revenue' });
    }
});

app.get('/api/admin/commissions', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const commissions = await LocalDB.getAllCommissions();
        res.json(commissions);
    } catch (e) {
        console.error('[Commissions] Error:', e);
        res.status(500).json({ error: 'Failed to get commissions' });
    }
});

app.get('/api/admin/my-commission', requireAdmin, async (req, res) => {
    try {
        const commission = await LocalDB.getAdminCommission(req.adminUid);
        res.json(commission || { totalEarned: 0, totalPaid: 0, commissionRate: 0 });
    } catch (e) {
        console.error('[My Commission] Error:', e);
        res.status(500).json({ error: 'Failed to get commission' });
    }
});

app.put('/api/admin/commissions/:uid/rate', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { uid } = req.params;
        const { campusId, rate } = req.body;
        
        await LocalDB.setAdminCommission(uid, campusId, rate);
        res.json({ success: true });
    } catch (e) {
        console.error('[Set Commission Rate] Error:', e);
        res.status(500).json({ error: 'Failed to set commission rate' });
    }
});

app.post('/api/admin/commissions/:uid/payout', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { uid } = req.params;
        const { amount, paymentMethod, paymentRef } = req.body;
        
        await LocalDB.recordCommissionPayout(uid, amount, req.adminUid, paymentMethod, paymentRef);
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'payout',
            entityType: 'commission',
            entityId: uid,
            changesSummary: { amount, paymentMethod, paymentRef }
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Commission Payout] Error:', e);
        res.status(500).json({ error: 'Failed to record payout' });
    }
});

// --- MIGRATION TOOL ---

// Setup initial university and campuses
app.post('/api/admin/setup/university', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { name, shortCode, campuses } = req.body;
        
        const uniId = `uni_${Date.now()}`;
        await LocalDB.createUniversity({ id: uniId, name, shortCode });
        
        const createdCampuses = [];
        for (const campus of campuses) {
            const campusId = `campus_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const created = await LocalDB.createCampus({
                id: campusId,
                universityId: uniId,
                name: campus.name,
                slug: campus.slug
            });
            createdCampuses.push(created);
        }
        
        res.json({ success: true, university: { id: uniId, name, shortCode }, campuses: createdCampuses });
    } catch (e) {
        console.error('[Setup University] Error:', e);
        res.status(500).json({ error: 'Setup failed' });
    }
});

// Granular Structure Management
app.post('/api/admin/universities', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { name, shortCode, structureType } = req.body;
        const id = `uni_${shortCode.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const result = await LocalDB.createUniversity({ id, name, shortCode, structureType });
        res.json({ success: true, university: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/universities/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, shortCode, structureType } = req.body;
        const result = await LocalDB.updateUniversity(id, { name, shortCode, structureType });
        res.json({ success: true, university: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/universities/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
     try {
        await LocalDB.deleteUniversity(req.params.id);
        res.json({ success: true });
     } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/campuses', requireAdmin, async (req, res) => {
    try {
        const { universityId, name, slug } = req.body;
        
        // Scope Validation
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
            const [type, scopeId] = req.admin.scope.split(':');
            if (type !== 'university' || scopeId !== universityId) {
                return res.status(403).json({ error: 'Unauthorized: You can only manage campuses for your assigned university' });
            }
        }

        // Ensure slug is unique ID
        const result = await LocalDB.createCampus({ id: slug, universityId, name, slug });
        res.json({ success: true, campus: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/campuses/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, slug, universityId } = req.body;
        
        // Scope Validation
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
            const [type, scopeId] = req.admin.scope.split(':');
            
            // Check if user has access to target university
            if (type !== 'university' || scopeId !== universityId) {
                 return res.status(403).json({ error: 'Unauthorized: Scope Mismatch' });
            }
            
            // Also need to verify the campus being edited belongs to this university
            // (Unless we trust universityId in body matches the existing campus, but safest is to check existing)
            const existing = await LocalDB.getCampus(id);
            if (existing && existing.universityId !== scopeId) {
                return res.status(403).json({ error: 'Unauthorized: Campus belongs to another university' });
            }
        }

        const result = await LocalDB.updateCampus(id, { name, slug, universityId });
        res.json({ success: true, campus: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/campuses/:id', requireAdmin, async (req, res) => {
     try {
        const { id } = req.params;
        
        // Scope Check (Need to fetch campus to know university)
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
             const campus = await LocalDB.getCampus(id);
             if (!campus) return res.status(404).json({ error: 'Campus not found' });
             
             const [type, scopeId] = req.admin.scope.split(':');
             if (type !== 'university' || scopeId !== campus.universityId) {
                 return res.status(403).json({ error: 'Unauthorized' });
             }
        }

        await LocalDB.deleteCampus(id);
        res.json({ success: true });
     } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all campuses (for migration tool dropdown)
// Get all campuses (Filtered by Scope)
app.get('/api/admin/campuses', requireAdmin, async (req, res) => {
    try {
        let campuses = await LocalDB.getCampuses();
        
        // Scope Filtering
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
             const [scopeType, scopeId] = req.admin.scope.split(':');
             if (scopeType === 'campus') {
                 campuses = campuses.filter(c => c.id === scopeId);
             } else if (scopeType === 'university') {
                 campuses = campuses.filter(c => c.universityId === scopeId);
             }
        }

        res.json(campuses);
    } catch (e) {
        console.error('[Get Campuses] Error:', e);
        res.status(500).json({ error: 'Failed to get campuses' });
    }
});

// ============================================
// HIERARCHY MANAGEMENT (Faculty, Dept, Option)
// ============================================

// FACULTIES
app.post('/api/admin/faculties', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.createFaculty(req.body);
        res.json({ success: true, faculty: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/faculties/:id', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.updateFaculty(req.params.id, req.body);
        res.json({ success: true, faculty: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/faculties/:id', requireAdmin, async (req, res) => {
    try {
        await LocalDB.deleteFaculty(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DEPARTMENTS
app.get('/api/admin/departments', requireAdmin, async (req, res) => {
    try {
        // Filter by facultyId if provided
        if (req.query.facultyId) {
             const depts = await LocalDB.getDepartments(req.query.facultyId);
             return res.json(depts);
        }
        const depts = await LocalDB.getAllDepartments();
        res.json(depts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/departments', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.createDepartment(req.body);
        res.json({ success: true, department: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/departments/:id', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.updateDepartment(req.params.id, req.body);
        res.json({ success: true, department: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/departments/:id', requireAdmin, async (req, res) => {
    try {
        await LocalDB.deleteDepartment(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// OPTIONS
app.get('/api/admin/options', requireAdmin, async (req, res) => {
    try {
        if (req.query.departmentId) {
             const options = await LocalDB.getOptions(req.query.departmentId);
             return res.json(options);
        }
        const options = await LocalDB.getAllOptions();
        res.json(options);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/options', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.createOption(req.body);
        res.json({ success: true, option: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/options/:id', requireAdmin, async (req, res) => {
    try {
        const result = await LocalDB.updateOption(req.params.id, req.body);
        res.json({ success: true, option: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/options/:id', requireAdmin, async (req, res) => {
    try {
        await LocalDB.deleteOption(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all universities (Filtered by Scope)
app.get('/api/admin/universities', requireAdmin, async (req, res) => {
    try {
        let universities = await LocalDB.getUniversities(); // Assumption: LocalDB.getUniversities exists? it should.
        // Actually, we created /api/universities public endpoint too.
        // We need to check if getUniversities exists in LocalDB.
        // If not, use DB query directly. 
        // Let's assume it exists or use query.
        // Let's use direct query to be safe if method missing, or check database.js first?
        // database.js likely has getUniversities() used by public endpoint.
        // Public endpoint uses: app.get('/api/universities', ...) which calls LocalDB.getUniversities().
        
        // Scope Filtering
        if (req.admin.role !== 'super' && req.admin.scope !== '*') {
             const [scopeType, scopeId] = req.admin.scope.split(':');
             if (scopeType === 'university') {
                 universities = universities.filter(u => u.id === scopeId);
             } else if (scopeType === 'campus') {
                 // Admin of a campus should likely see their university?
                 // Or we find which uni this campus belongs to.
                 const campus = await LocalDB.db.get('SELECT universityId FROM campuses WHERE id = ?', [scopeId]);
                 if (campus) {
                     universities = universities.filter(u => u.id === campus.universityId);
                 } else {
                     universities = [];
                 }
             }
        }
        
        res.json(universities);
    } catch (e) {
        console.error('[Get Admin Universities] Error:', e);
        res.status(500).json({ error: 'Failed to get universities' });
    }
});

// --- FIREBASE SYNC (Manual Trigger) ---

app.post('/api/admin/sync/to-firebase', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ error: 'Firebase not configured' });
        }
        
        // Get all pending sync items
        const pending = await LocalDB.getPendingSyncItems(1000);
        
        if (pending.length === 0) {
            return res.json({ success: true, synced: 0, message: 'No pending changes' });
        }
        
        // Process sync
        let synced = 0;
        for (const item of pending) {
            try {
                const docRef = db.collection(item.collection).doc(item.docId);
                if (item.operation === 'delete') {
                    await docRef.delete();
                } else {
                    await docRef.set(item.data, { merge: true });
                }
                synced++;
            } catch (e) {
                console.error(`[Sync] Failed item ${item.id}:`, e.message);
            }
        }
        
        // Clear processed items
        await LocalDB.removeSyncItems(pending.map(p => p.id));
        
        // Audit log
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'sync_to_firebase',
            entityType: 'system',
            affectedCount: synced
        });
        
        res.json({ success: true, synced });
    } catch (e) {
        console.error('[Sync to Firebase] Error:', e);
        res.status(500).json({ error: 'Sync failed' });
    }
});

app.get('/api/admin/sync/status', requireAdmin, async (req, res) => {
    try {
        const pending = await LocalDB.getPendingSyncItems(1);
        const count = await LocalDB.db.get('SELECT COUNT(*) as count FROM sync_queue');
        res.json({ pendingCount: count?.count || 0 });
    } catch (e) {
        console.error('[Sync Status] Error:', e);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// ============================================
// ADS/BILLBOARD SYSTEM API ROUTES
// ============================================



// Configure multer for ad media uploads
const adStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads', 'ads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        const prefix = file.mimetype.startsWith('video') ? 'vid' : 'img';
        cb(null, `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${ext}`);
    }
});

const adUpload = multer({
    storage: adStorage,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: JPEG, PNG, GIF, WebP, MP4, WebM'), false);
        }
    }
});

// Serve uploaded ad media
app.use('/uploads/ads', express.static(path.join(__dirname, 'uploads', 'ads')));

// Seed test ad (dev only)
app.post('/api/seed/ad', async (req, res) => {
    try {
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Seed endpoints disabled in production' });
        }
        
        const ad = await LocalDB.createAd({
            ...req.body,
            createdBy: 'seed-script'
        });
        
        console.log(`[Seed] Created ad: ${ad.title}`);
        res.json({ success: true, ad });
    } catch (e) {
        console.error('[Seed Ad] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get all ads (Super Admin only for full list, or filtered for public)
app.get('/api/ads', async (req, res) => {
    try {
        const { status, scope, universityId, activeNow } = req.query;
        const filters = {};
        
        if (status) filters.status = status;
        if (scope) filters.scope = scope;
        if (universityId) filters.universityId = universityId;
        if (activeNow === 'true') {
            filters.activeNow = true;
            filters.status = 'live';
            filters.enabled = true;
        }
        
        const ads = await LocalDB.getAds(filters);
        res.json(ads);
    } catch (e) {
        console.error('[Get Ads] Error:', e);
        res.status(500).json({ error: 'Failed to get ads' });
    }
});

// Create ad (Super Admin only)
app.post('/api/ads', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const ad = await LocalDB.createAd({
            ...req.body,
            createdBy: req.adminEmail
        });
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'create_ad',
            entityType: 'ads',
            entityId: ad.id,
            changesSummary: `Created ad: ${ad.title}`
        });
        
        res.json(ad);
    } catch (e) {
        console.error('[Create Ad] Error:', e);
        res.status(500).json({ error: 'Failed to create ad' });
    }
});

// IMPORTANT: These specific routes MUST come BEFORE /api/ads/:id

// Get ad settings (specific path must be before :id)
app.get('/api/ads/settings', async (req, res) => {
    try {
        const settings = await LocalDB.getAdSettings();
        res.json(settings);
    } catch (e) {
        console.error('[Get Ad Settings] Error:', e);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});

// Seed ad settings update (dev only - bypasses auth)
app.put('/api/seed/ads/settings', async (req, res) => {
    try {
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Seed endpoints disabled in production' });
        }
        
        const settings = await LocalDB.updateAdSettings(req.body, 'seed-script');
        console.log(`[Seed] Updated ad settings:`, req.body);
        res.json({ success: true, settings });
    } catch (e) {
        console.error('[Seed Ad Settings] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Update ad settings (Super Admin only)
app.put('/api/ads/settings', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const settings = await LocalDB.updateAdSettings(req.body, req.adminEmail);
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'update_ad_settings',
            entityType: 'ad_settings',
            changesSummary: `Updated ad settings: ${JSON.stringify(req.body)}`
        });
        
        res.json(settings);
    } catch (e) {
        console.error('[Update Ad Settings] Error:', e);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Upload ad media (Super Admin only)
app.post('/api/ads/upload', requireAdmin, requireSuperAdmin, adUpload.single('media'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const mediaUrl = `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/uploads/ads/${req.file.filename}`;
        res.json({ 
            success: true, 
            mediaUrl,
            filename: req.file.filename,
            mimetype: req.file.mimetype,
            size: req.file.size
        });
    } catch (e) {
        console.error('[Upload Ad Media] Error:', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Pause all ads (Super Admin only)
app.post('/api/ads/pause-all', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        await LocalDB.pauseAllAds();
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'pause_all_ads',
            entityType: 'ads',
            changesSummary: 'Paused all live ads'
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Pause All Ads] Error:', e);
        res.status(500).json({ error: 'Failed to pause ads' });
    }
});

// Resume all ads (Super Admin only)
app.post('/api/ads/resume-all', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        await LocalDB.resumeAllAds();
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'resume_all_ads',
            entityType: 'ads',
            changesSummary: 'Resumed all paused ads'
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Resume All Ads] Error:', e);
        res.status(500).json({ error: 'Failed to resume ads' });
    }
});

// NOW the :id routes can come after specific paths

// Get single ad
app.get('/api/ads/:id', async (req, res) => {
    try {
        const ad = await LocalDB.getAd(req.params.id);
        if (!ad) return res.status(404).json({ error: 'Ad not found' });
        res.json(ad);
    } catch (e) {
        console.error('[Get Ad] Error:', e);
        res.status(500).json({ error: 'Failed to get ad' });
    }
});

// Update ad (Super Admin only)
app.put('/api/ads/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        const ad = await LocalDB.updateAd(req.params.id, req.body);
        if (!ad) return res.status(404).json({ error: 'Ad not found' });
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'update_ad',
            entityType: 'ads',
            entityId: req.params.id,
            changesSummary: `Updated ad: ${ad.title}`
        });
        
        res.json(ad);
    } catch (e) {
        console.error('[Update Ad] Error:', e);
        res.status(500).json({ error: 'Failed to update ad' });
    }
});

// Delete ad (Super Admin only)
app.delete('/api/ads/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
    try {
        // Get ad first to delete media file
        const ad = await LocalDB.getAd(req.params.id);
        if (!ad) return res.status(404).json({ error: 'Ad not found' });
        
        // Delete media file if exists
        if (ad.mediaUrl && ad.mediaUrl.includes('/uploads/ads/')) {
            const filename = ad.mediaUrl.split('/uploads/ads/')[1];
            const filepath = path.join(__dirname, 'uploads', 'ads', filename);
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
        }
        
        await LocalDB.deleteAd(req.params.id);
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'delete_ad',
            entityType: 'ads',
            entityId: req.params.id,
            changesSummary: `Deleted ad: ${ad.title}`
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Delete Ad] Error:', e);
        res.status(500).json({ error: 'Failed to delete ad' });
    }
});

// Track ad click (public endpoint)
app.post('/api/ads/:id/click', async (req, res) => {
    try {
        await LocalDB.trackAdClick(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[Track Ad Click] Error:', e);
        res.status(500).json({ error: 'Failed to track click' });
    }
});

// Track ad impression (public endpoint)
app.post('/api/ads/:id/impression', async (req, res) => {
    try {
        await LocalDB.trackAdImpression(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[Track Ad Impression] Error:', e);
        res.status(500).json({ error: 'Failed to track impression' });
    }
});

// ============================================
// COURSE PRESETS API
// ============================================

// Get presets (public - filtered by campus, or all for admin)
app.get('/api/presets', async (req, res) => {
    try {
        const { campusId } = req.query;
        const presets = await LocalDB.getPresets(campusId);
        
        // Parse units JSON string to array for each preset
        const parsed = presets.map(p => ({
            ...p,
            units: typeof p.units === 'string' ? JSON.parse(p.units) : p.units,
            enabled: !!p.enabled
        }));
        
        res.json(parsed);
    } catch (e) {
        console.error('[Get Presets] Error:', e);
        res.status(500).json({ error: 'Failed to get presets' });
    }
});

// Create single preset (Admin only)
app.post('/api/presets', requireAdmin, async (req, res) => {
    try {
        const preset = await LocalDB.createPreset({
            ...req.body,
            createdBy: req.adminEmail
        });
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'create_preset',
            entityType: 'presets',
            entityId: preset.id,
            changesSummary: `Created preset: ${preset.name}`
        });
        
        res.json({
            ...preset,
            units: typeof preset.units === 'string' ? JSON.parse(preset.units) : preset.units
        });
    } catch (e) {
        console.error('[Create Preset] Error:', e);
        res.status(500).json({ error: 'Failed to create preset' });
    }
});

// Bulk import presets (Admin only)
app.post('/api/presets/bulk', requireAdmin, async (req, res) => {
    try {
        const { presets, campusId, replaceExisting } = req.body;
        
        if (!campusId) {
            return res.status(400).json({ error: 'campusId is required' });
        }
        
        if (!presets || !Array.isArray(presets)) {
            return res.status(400).json({ error: 'presets must be an array' });
        }
        
        // Delete existing presets for this campus if replaceExisting is true
        if (replaceExisting) {
            await LocalDB.deletePresetsByCampus(campusId);
        }
        
        const created = await LocalDB.createPresetsBulk(presets, campusId, req.adminEmail);
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'bulk_import_presets',
            entityType: 'presets',
            changesSummary: `Imported ${created.length} presets for campus ${campusId}`
        });
        
        res.json({ 
            success: true, 
            count: created.length,
            presets: created.map(p => ({
                ...p,
                units: typeof p.units === 'string' ? JSON.parse(p.units) : p.units
            }))
        });
    } catch (e) {
        console.error('[Bulk Import Presets] Error:', e);
        res.status(500).json({ error: 'Failed to import presets' });
    }
});

// Update preset (Admin only)
app.put('/api/presets/:id', requireAdmin, async (req, res) => {
    try {
        const preset = await LocalDB.updatePreset(req.params.id, req.body);
        if (!preset) return res.status(404).json({ error: 'Preset not found' });
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'update_preset',
            entityType: 'presets',
            entityId: req.params.id,
            changesSummary: `Updated preset: ${preset.name}`
        });
        
        res.json({
            ...preset,
            units: typeof preset.units === 'string' ? JSON.parse(preset.units) : preset.units
        });
    } catch (e) {
        console.error('[Update Preset] Error:', e);
        res.status(500).json({ error: 'Failed to update preset' });
    }
});

// Delete preset (Admin only)
app.delete('/api/presets/:id', requireAdmin, async (req, res) => {
    try {
        const preset = await LocalDB.deletePreset(req.params.id);
        if (!preset) return res.status(404).json({ error: 'Preset not found' });
        
        await LocalDB.createAuditLog({
            adminUid: req.adminUid,
            adminEmail: req.adminEmail,
            action: 'delete_preset',
            entityType: 'presets',
            entityId: req.params.id,
            changesSummary: `Deleted preset: ${preset.name}`
        });
        
        res.json({ success: true });
    } catch (e) {
        console.error('[Delete Preset] Error:', e);
        res.status(500).json({ error: 'Failed to delete preset' });
    }
});

// --- END OF ROUTES ---

const runningServer = server.listen(PORT, () => {
    console.log(`Secure Server running on port ${PORT}`);
});

module.exports = runningServer;
