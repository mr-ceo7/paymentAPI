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
                    await docRef.set(data, { merge: true });
                } else if (operation === 'delete') {
                    await docRef.delete();
                }

                processedIds.push(item.id);
            } catch (e) {
                console.error(`[SyncService] Failed to sync item ${item.id}:`, e.message);
                console.warn(`[SyncService] Skipping item ${item.id} to avoid blockage.`);
                processedIds.push(item.id); 
            }
        }

        if (processedIds.length > 0) {
            await LocalDB.removeSyncItems(processedIds);
            console.log(`[SyncService] Synced ${processedIds.length} items to Cloud.`);
        }
    }

    // Hydrate LocalDB from Cloud (One-way downstream)
    async hydrateUsers() {
        if (!this.firestore) {
            console.warn('[SyncService] Cannot hydrate: Firestore not connected.');
            return 0;
        }

        console.log('[SyncService] Starting User Hydration...');
        const snapshot = await this.firestore.collection('users').get();
        if (snapshot.empty) {
            console.log('[SyncService] No users found in Cloud.');
            return 0;
        }

        let count = 0;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            await LocalDB.importUser({
                uid: doc.id,
                credits: data.credits || 0,
                unlimitedExpiresAt: data.unlimitedExpiresAt || null,
                lastDailyReset: data.lastDailyReset || null,
                lastPaymentRef: data.lastPaymentRef || 'CLOUD_IMPORT'
            });
            count++;
        }
        console.log(`[SyncService] Hydrated ${count} users from Cloud.`);
        return count;
    }
}

module.exports = new SyncService();
