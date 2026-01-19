const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

class LocalDatabase {
    constructor() {
        this.db = null;
    }

    async init() {
        // Ensure data dir exists
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
        }

        this.db = await open({
            filename: path.join(dataDir, 'database.sqlite'),
            driver: sqlite3.Database
        });

        console.log('[LocalDB] Connected to SQLite');
        await this.createTables();
    }

    async createTables() {
        // Transactions Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                uid TEXT,
                planId TEXT,
                amount INTEGER,
                phone TEXT,
                mpesaCode TEXT,
                status TEXT,
                type TEXT,
                createdAt DATETIME,
                verifiedAt DATETIME,
                failureReason TEXT,
                verificationMetadata TEXT
            )
        `);

        // Users Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                uid TEXT PRIMARY KEY,
                credits INTEGER DEFAULT 0,
                unlimitedExpiresAt DATETIME,
                lastDailyReset DATETIME,
                lastPaymentRef TEXT
            )
        `);

        // Migration: Ensure lastDailyReset exists for existing tables
        try {
            // Check if column exists first to avoid error spam
            const result = await this.db.all("PRAGMA table_info(users)");
            const hasColumn = result.some(c => c.name === 'lastDailyReset');
            
            if (!hasColumn) {
                console.log('[LocalDB] Migrating: Adding lastDailyReset column to users table...');
                await this.db.exec("ALTER TABLE users ADD COLUMN lastDailyReset DATETIME");
            }
        } catch (e) {
            console.error('[LocalDB] Migration Error:', e);
        }

        // Sync Queue Table (For changes that need to go to Firebase)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS sync_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT,
                docId TEXT,
                operation TEXT, -- 'create', 'update', 'delete'
                data TEXT, -- JSON string
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('[LocalDB] Tables initialized');
    }

    // --- Transactions ---

    async createTransaction(data) {
        const { id, uid, planId, amount, phone, mpesaCode, status, type, createdAt } = data;
        
        await this.db.run(`
            INSERT INTO transactions (id, uid, planId, amount, phone, mpesaCode, status, type, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, uid, planId, amount, phone, mpesaCode, status, type, createdAt]);

        // Queue for Sync
        await this.addToSyncQueue('transactions', id, 'create', data);
        
        return { id, ...data };
    }

    async getTransaction(id) {
        return await this.db.get('SELECT * FROM transactions WHERE id = ?', id);
    }

    async getTransactionByCode(code) {
        return await this.db.get('SELECT * FROM transactions WHERE mpesaCode = ?', code);
    }

    async updateTransactionStatus(id, status, updates = {}) {
        const { verifiedAt, failureReason, verificationMetadata } = updates;
        const metaStr = verificationMetadata ? JSON.stringify(verificationMetadata) : null;

        await this.db.run(`
            UPDATE transactions 
            SET status = ?, verifiedAt = ?, failureReason = ?, verificationMetadata = ?
            WHERE id = ?
        `, [status, verifiedAt, failureReason, metaStr, id]);

        // Queue Update
        await this.addToSyncQueue('transactions', id, 'update', { status, ...updates });
        return await this.getTransaction(id);
    }

    async getPendingVerifications() {
        return await this.db.all("SELECT * FROM transactions WHERE status = 'MANUAL_VERIFYING'");
    }

    async getAllTransactions() {
        return await this.db.all("SELECT * FROM transactions ORDER BY createdAt DESC");
    }

    async getStats() {
        const verified = await this.db.get("SELECT COUNT(*) as count, SUM(amount) as revenue FROM transactions WHERE status = 'COMPLETED'");
        const rejected = await this.db.get("SELECT COUNT(*) as count FROM transactions WHERE status = 'FAILED'");
        const pending = await this.db.get("SELECT COUNT(*) as count FROM transactions WHERE status = 'MANUAL_VERIFYING'");
        const recent = await this.db.all("SELECT * FROM transactions ORDER BY createdAt DESC LIMIT 10");

        return {
            verified: verified.count || 0,
            revenue: verified.revenue || 0,
            rejected: rejected.count || 0,
            pending: pending.count || 0,
            recentTransactions: recent.map(t => ({
                ...t,
                date: t.createdAt // Ensure date format matches frontend expectation
            }))
        };
    }

    async expireStaleTransactions(cutoffDate) {
        const result = await this.db.run(`
            UPDATE transactions 
            SET status = 'FAILED', failureReason = 'Timeout' 
            WHERE status = 'MANUAL_VERIFYING' AND createdAt < ?
        `, cutoffDate);
        return result.changes;
    }

    async pruneOldTransactions(daysToKeep = 7) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        const isoCutoff = cutoffDate.toISOString();

        const result = await this.db.run(`
            DELETE FROM transactions 
            WHERE createdAt < ?
        `, isoCutoff);
        
        return result.changes;
    }

    async deleteTransaction(id) {
        const result = await this.db.run('DELETE FROM transactions WHERE id = ?', id);
        return result.changes;
    }

    async clearAllStats() {
        const result = await this.db.run("DELETE FROM transactions");
        return result.changes;
    }

    // --- Users ---

    async getAllUsers() {
        return await this.db.all("SELECT * FROM users ORDER BY credits DESC");
    }

    async getUser(uid) {
        let user = await this.db.get('SELECT * FROM users WHERE uid = ?', uid);
        
        // Lazy Daily Reset Logic
        if (user) {
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const lastReset = user.lastDailyReset ? user.lastDailyReset.split('T')[0] : null;

            if (lastReset !== today) {
                // It's a new day!
                if (user.credits < 3) {
                    console.log(`[DailyReward] Resetting user ${uid} to 3 credits.`);
                    await this.db.run(`
                        UPDATE users 
                        SET credits = 3, lastDailyReset = ? 
                        WHERE uid = ?
                    `, [new Date().toISOString(), uid]);
                    
                    // Fetch updated user
                    user = await this.db.get('SELECT * FROM users WHERE uid = ?', uid);
                } else {
                     // Just update the date tracker so we don't check again today needed? 
                     // Actually, if credits >= 3, we don't give free ones, but we should mark today as checked 
                     // so we don't re-eval if they drop below 3 later today?
                     // "Reset to 3 daily" usually implies "If you start the day with 0, you get 3". 
                     // If you have 5 paid credits, you don't get free ones.
                     
                     // Let's explicitly update the timestamp to TODAY so we know we processed them.
                     await this.db.run(`UPDATE users SET lastDailyReset = ? WHERE uid = ?`, [new Date().toISOString(), uid]);
                     user.lastDailyReset = new Date().toISOString();
                }
            }
        } else {
             // Create new user with default 3 credits (First day bonus)
             const now = new Date().toISOString();
             await this.db.run(`
                INSERT INTO users (uid, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef) 
                VALUES (?, 3, NULL, ?, 'INIT_BONUS')
             `, [uid, now]);
             user = { uid, credits: 3, unlimitedExpiresAt: null, lastDailyReset: now, lastPaymentRef: 'INIT_BONUS' };
        }

        return user;
    }

    async updateUserCredits(uid, creditsToAdd, isUnlimited, txnRef) {
        // Upsert User
        let user = await this.db.get('SELECT * FROM users WHERE uid = ?', uid); 
        
        let newCredits = (user ? user.credits : 0);
        let unlimitedExpires = (user ? user.unlimitedExpiresAt : null);
        let lastDailyReset = (user ? user.lastDailyReset : new Date().toISOString());
        // Preserve existing email if updating, but we don't usually update email here.
        let email = (user ? user.email : null); 

        if (isUnlimited) {
            const date = new Date();
            date.setDate(date.getDate() + 30);
            unlimitedExpires = date.toISOString();
        } else {
            newCredits += creditsToAdd;
        }

        if (user) {
            await this.db.run(`
                UPDATE users SET credits = ?, unlimitedExpiresAt = ?, lastDailyReset = ?, lastPaymentRef = ? WHERE uid = ?
            `, [newCredits, unlimitedExpires, lastDailyReset, txnRef, uid]);
        } else {
             await this.db.run(`
                INSERT INTO users (uid, email, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef) VALUES (?, ?, ?, ?, ?, ?)
            `, [uid, email, newCredits, unlimitedExpires, lastDailyReset, txnRef]);
        }

        // Sync Queue
        await this.addToSyncQueue('users', uid, 'update', { 
            credits: newCredits, 
            unlimitedExpiresAt: unlimitedExpires,
            lastDailyReset,
            lastPaymentRef: txnRef 
            // Don't overwrite email in cloud with null if we don't have it
        }); 
    }

    // Import from Cloud (Bypasses Sync Queue)
    async importUser(data) {
        const { uid, email, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef } = data;
        
        const existing = await this.db.get('SELECT uid FROM users WHERE uid = ?', uid);
        
        if (existing) {
             await this.db.run(`
                UPDATE users SET email = ?, credits = ?, unlimitedExpiresAt = ?, lastDailyReset = ?, lastPaymentRef = ? WHERE uid = ?
            `, [email, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef, uid]);
        } else {
             await this.db.run(`
                INSERT INTO users (uid, email, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef) VALUES (?, ?, ?, ?, ?, ?)
            `, [uid, email, credits, unlimitedExpiresAt, lastDailyReset, lastPaymentRef]);
        }
        return { success: true };
    }

    // --- Sync Queue ---

    async addToSyncQueue(collection, docId, operation, data) {
        await this.db.run(`
            INSERT INTO sync_queue (collection, docId, operation, data)
            VALUES (?, ?, ?, ?)
        `, [collection, docId, operation, JSON.stringify(data)]);
    }

    async getPendingSyncItems(limit = 50) {
        const items = await this.db.all('SELECT * FROM sync_queue ORDER BY id ASC LIMIT ?', limit);
        return items.map(item => ({...item, data: JSON.parse(item.data)}));
    }

    async removeSyncItems(ids) {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        await this.db.run(`DELETE FROM sync_queue WHERE id IN (${placeholders})`, ids);
    }
}

module.exports = new LocalDatabase();
