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
                lastPaymentRef TEXT
            )
        `);

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
        return await this.db.get('SELECT * FROM users WHERE uid = ?', uid);
    }

    async updateUserCredits(uid, creditsToAdd, isUnlimited, txnRef) {
        // Upsert User
        const user = await this.getUser(uid);
        
        let newCredits = (user ? user.credits : 0);
        let unlimitedExpires = (user ? user.unlimitedExpiresAt : null);

        if (isUnlimited) {
            const date = new Date();
            date.setDate(date.getDate() + 30);
            unlimitedExpires = date.toISOString();
        } else {
            newCredits += creditsToAdd;
        }

        if (user) {
            await this.db.run(`
                UPDATE users SET credits = ?, unlimitedExpiresAt = ?, lastPaymentRef = ? WHERE uid = ?
            `, [newCredits, unlimitedExpires, txnRef, uid]);
        } else {
             await this.db.run(`
                INSERT INTO users (uid, credits, unlimitedExpiresAt, lastPaymentRef) VALUES (?, ?, ?, ?)
            `, [uid, newCredits, unlimitedExpires, txnRef]);
        }

        // Sync Queue
        await this.addToSyncQueue('users', uid, 'update', { 
            credits: newCredits, 
            unlimitedExpiresAt: unlimitedExpires,
            lastPaymentRef: txnRef 
        }); // Note: 'update' op works for upsert in Firestore if we use set merge:true
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
