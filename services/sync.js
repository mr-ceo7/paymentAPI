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
                email: data.email || null, // Map email
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

    // Hydrate timetable data from Cloud (universities, campuses, timetables)
    async hydrateTimetables() {
        if (!this.firestore) {
            console.warn('[SyncService] Cannot hydrate timetables: Firestore not connected.');
            return { universities: 0, campuses: 0, timetables: 0 };
        }

        // Check if we need to hydrate (only if timetables table is empty)
        const stats = await LocalDB.getTimetableStats();
        if (stats.total > 0) {
            console.log(`[SyncService] Timetables already present (${stats.total}), skipping hydration.`);
            return { universities: 0, campuses: 0, timetables: 0, skipped: true };
        }

        console.log('[SyncService] Starting Timetable Hydration from Cloud...');
        const result = { universities: 0, campuses: 0, timetables: 0 };

        try {
            // 1. Hydrate Universities
            const uniSnapshot = await this.firestore.collection('universities').get();
            for (const doc of uniSnapshot.docs) {
                const data = doc.data();
                try {
                    await LocalDB.db.run(`
                        INSERT OR IGNORE INTO universities (id, name, shortCode, createdAt)
                        VALUES (?, ?, ?, ?)
                    `, [doc.id, data.name, data.shortCode, data.createdAt || new Date().toISOString()]);
                    result.universities++;
                } catch (e) {
                    console.warn(`[SyncService] Failed to import university ${doc.id}:`, e.message);
                }
            }
            console.log(`[SyncService] Hydrated ${result.universities} universities.`);

            // 2. Hydrate Campuses
            const campusSnapshot = await this.firestore.collection('campuses').get();
            for (const doc of campusSnapshot.docs) {
                const data = doc.data();
                try {
                    await LocalDB.db.run(`
                        INSERT OR IGNORE INTO campuses (id, universityId, name, slug, dataVersion, createdAt)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [doc.id, data.universityId, data.name, data.slug, data.dataVersion || 1, data.createdAt || new Date().toISOString()]);
                    result.campuses++;
                } catch (e) {
                    console.warn(`[SyncService] Failed to import campus ${doc.id}:`, e.message);
                }
            }
            console.log(`[SyncService] Hydrated ${result.campuses} campuses.`);

            // 3. Hydrate Timetables
            const timetableSnapshot = await this.firestore.collection('timetables').get();
            for (const doc of timetableSnapshot.docs) {
                const data = doc.data();
                try {
                    await LocalDB.db.run(`
                        INSERT OR IGNORE INTO timetables (id, campusId, facultyId, code, title, date, time, venue, level, semester, createdAt, updatedAt, createdBy)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        doc.id, 
                        data.campusId, 
                        data.facultyId || null, 
                        data.code, 
                        data.title || 'Unit Title Not Specified', 
                        data.date, 
                        data.time, 
                        data.venue || '', 
                        data.level || 1, 
                        data.semester || null,
                        data.createdAt || new Date().toISOString(),
                        data.updatedAt || new Date().toISOString(),
                        data.createdBy || 'CLOUD_IMPORT'
                    ]);
                    result.timetables++;
                } catch (e) {
                    console.warn(`[SyncService] Failed to import timetable ${doc.id}:`, e.message);
                }
            }
            console.log(`[SyncService] Hydrated ${result.timetables} timetables.`);

            // 4. Hydrate Admins
            const adminSnapshot = await this.firestore.collection('admins').get();
            for (const doc of adminSnapshot.docs) {
                const data = doc.data();
                try {
                    await LocalDB.db.run(`
                        INSERT OR IGNORE INTO admins (uid, email, role, scope, createdAt, createdBy)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [doc.id, data.email, data.role, data.scope || '*', data.createdAt || new Date().toISOString(), data.createdBy || 'CLOUD_IMPORT']);
                } catch (e) {
                    // Ignore duplicate admin entries
                }
            }

        } catch (error) {
            console.error('[SyncService] Hydration error:', error.message);
        }

        console.log(`[SyncService] Hydration complete: ${result.universities} universities, ${result.campuses} campuses, ${result.timetables} timetables`);
        return result;
    }
}

module.exports = new SyncService();
