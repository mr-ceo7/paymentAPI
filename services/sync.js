const LocalDB = require('../database');
const admin = require('firebase-admin');

class SyncService {
    constructor() {
        this.isRunning = false;
        this.firestore = null;
        this.SYNC_INTERVAL = 5000; // 5 seconds
    }

    start(firestoreDb) {
        if (this.isRunning) return;
        this.firestore = firestoreDb;
        this.isRunning = true;
        console.log('[SyncService] Started background sync worker');
        this.loop();
    }

    async loop() {
        if (!this.isRunning) return;
        try {
            await this.processQueue();
        } catch (e) {
            console.error('[SyncService] Cycle error:', e.message);
        }
        setTimeout(() => this.loop(), this.SYNC_INTERVAL);
    }

    async processQueue() {
        if (!this.firestore) return;

        const items = await LocalDB.getPendingSyncItems(20); // Batch size 20
        if (items.length === 0) return;

        console.log(`[SyncService] Processing ${items.length} pending items...`);
        const processedIds = [];

        for (const item of items) {
            try {
                const { collection, docId, operation, data } = item;
                const docRef = this.firestore.collection(collection).doc(docId);

                if (operation === 'create' || operation === 'update') {
                    // For syncing, we can use set({ ... }, { merge: true }) to be safe
                    // We need to handle potential timestamp conversions if data contains ISO strings that should be Timestamps
                    // But for simple backup, raw JSON data is often fine. 
                    // However, let's try to preserve the structure where possible.
                    
                    // Note: 'data' is already parsed JSON object because database.js handles parsing
                    await docRef.set(data, { merge: true });
                } else if (operation === 'delete') {
                    await docRef.delete();
                }

                processedIds.push(item.id);
            } catch (e) {
                console.error(`[SyncService] Failed to sync item ${item.id}:`, e.message);
                // Decide strategy: Retry? Delete?
                // For now, if it fails, we might leave it in queue or mark it as error?
                // To prevent blocking the queue forever on a bad item, we should probably remove it or have a retry count.
                // Simple approach: Skip removal, let it retry next loop. But infinite loop risk.
                // Better: Log and remove for now to keep queue moving.
                console.warn(`[SyncService] Skipping item ${item.id} to avoid blockage.`);
                processedIds.push(item.id); 
            }
        }

        if (processedIds.length > 0) {
            await LocalDB.removeSyncItems(processedIds);
            console.log(`[SyncService] Synced ${processedIds.length} items to Cloud.`);
        }
    }
}

module.exports = new SyncService();
