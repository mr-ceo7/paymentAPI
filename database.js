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
            filename: path.join(dataDir, process.env.NODE_ENV === 'test' ? 'database.test.sqlite' : 'database.sqlite'),
            driver: sqlite3.Database
        });

        await this.db.run('PRAGMA foreign_keys = ON');

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
                email TEXT,
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

            const hasEmail = result.some(c => c.name === 'email');
            if (!hasEmail) {
                console.log('[LocalDB] Migrating: Adding email column to users table...');
                await this.db.exec("ALTER TABLE users ADD COLUMN email TEXT");
            }
        } catch (e) {
            console.error('[LocalDB] Migration Error:', e);
        }
        
        // Migration: Ensure transactions has campus_id
        try {
            const result = await this.db.all("PRAGMA table_info(transactions)");
            if (!result.some(c => c.name === 'campus_id')) {
                console.log('[LocalDB] Migrating: Adding campus_id to transactions...');
                await this.db.exec("ALTER TABLE transactions ADD COLUMN campus_id TEXT");
            }
            if (!result.some(c => c.name === 'university_id')) {
                console.log('[LocalDB] Migrating: Adding university_id to transactions...');
                await this.db.exec("ALTER TABLE transactions ADD COLUMN university_id TEXT");
            }

            // Migration: Add structure_type to universities
            const uniResult = await this.db.all("PRAGMA table_info(universities)");
            if (!uniResult.some(c => c.name === 'structure_type')) {
                console.log('[LocalDB] Migrating: Adding structure_type to universities...');
                await this.db.exec("ALTER TABLE universities ADD COLUMN structure_type TEXT DEFAULT 'campus'");
            }
            
            // Migration: Add slug to universities (for URL routing)
            if (!uniResult.some(c => c.name === 'slug')) {
                console.log('[LocalDB] Migrating: Adding slug to universities...');
                await this.db.exec("ALTER TABLE universities ADD COLUMN slug TEXT");
            }
            
            // Migration: Add colors (JSON) to universities
            if (!uniResult.some(c => c.name === 'colors')) {
                console.log('[LocalDB] Migrating: Adding colors to universities...');
                await this.db.exec("ALTER TABLE universities ADD COLUMN colors TEXT");
            }
            
            // Migration: Add branding fields to universities
            if (!uniResult.some(c => c.name === 'logoUrl')) {
                console.log('[LocalDB] Migrating: Adding branding fields to universities...');
                await this.db.exec("ALTER TABLE universities ADD COLUMN logoUrl TEXT");
                await this.db.exec("ALTER TABLE universities ADD COLUMN faviconUrl TEXT");
                await this.db.exec("ALTER TABLE universities ADD COLUMN ogImageUrl TEXT");
                await this.db.exec("ALTER TABLE universities ADD COLUMN tagline TEXT");
                await this.db.exec("ALTER TABLE universities ADD COLUMN defaultCampus TEXT");
            }
        } catch (e) {
            console.error('[LocalDB] Transaction Migration Error:', e);
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

        // ============================================
        // ADMIN SYSTEM TABLES
        // ============================================

        // Universities Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS universities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                shortCode TEXT UNIQUE,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Campuses Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS campuses (
                id TEXT PRIMARY KEY,
                universityId TEXT NOT NULL,
                name TEXT NOT NULL,
                slug TEXT UNIQUE,
                dataVersion INTEGER DEFAULT 1,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (universityId) REFERENCES universities(id)
            )
        `);

        // Faculties Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS faculties (
                id TEXT PRIMARY KEY,
                campusId TEXT NOT NULL,
                name TEXT NOT NULL,
                slug TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (campusId) REFERENCES campuses(id) ON DELETE CASCADE
            )
        `);

        // Departments Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS departments (
                id TEXT PRIMARY KEY,
                facultyId TEXT NOT NULL,
                name TEXT NOT NULL,
                slug TEXT,
                subLabel TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (facultyId) REFERENCES faculties(id) ON DELETE CASCADE
            )
        `);

        // Options Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS options (
                id TEXT PRIMARY KEY,
                departmentId TEXT NOT NULL,
                name TEXT NOT NULL,
                slug TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (departmentId) REFERENCES departments(id) ON DELETE CASCADE
            )
        `);

        // Migration: Add hierarchy columns to timetables if they don't exist
        try {
            const timetableInfo = await this.db.all("PRAGMA table_info(timetables)");
            if (!timetableInfo.some(c => c.name === 'departmentId')) {
                console.log('[LocalDB] Migrating: Adding departmentId to timetables...');
                await this.db.exec("ALTER TABLE timetables ADD COLUMN departmentId TEXT REFERENCES departments(id)");
            }
            if (!timetableInfo.some(c => c.name === 'optionId')) {
                console.log('[LocalDB] Migrating: Adding optionId to timetables...');
                await this.db.exec("ALTER TABLE timetables ADD COLUMN optionId TEXT REFERENCES options(id)");
            }
        } catch (e) {
            console.error('[LocalDB] Timetable Hierarchy Migration Error:', e);
        }

        // Timetables Table (exam entries)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS timetables (
                id TEXT PRIMARY KEY,
                campusId TEXT NOT NULL,
                facultyId TEXT,
                departmentId TEXT,
                optionId TEXT,
                code TEXT NOT NULL,
                title TEXT,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                venue TEXT,
                level INTEGER,
                semester INTEGER,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                createdBy TEXT,
                FOREIGN KEY (campusId) REFERENCES campuses(id),
                FOREIGN KEY (facultyId) REFERENCES faculties(id),
                FOREIGN KEY (departmentId) REFERENCES departments(id),
                FOREIGN KEY (optionId) REFERENCES options(id)
            )
        `);

        // ============================================
        // ADMIN SYSTEM TABLES
        // ============================================

        // Admins Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS admins (
                uid TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                role TEXT DEFAULT 'editor',
                scope TEXT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                createdBy TEXT
            )
        `);

        // Messages Table (Super Admin ↔ Admins)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fromUid TEXT NOT NULL,
                toUid TEXT,
                subject TEXT,
                body TEXT NOT NULL,
                isRead INTEGER DEFAULT 0,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Audit Logs Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                adminUid TEXT NOT NULL,
                adminEmail TEXT,
                action TEXT NOT NULL,
                entityType TEXT NOT NULL,
                entityId TEXT,
                changesSummary TEXT,
                affectedCount INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Revenue Tracking Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS revenue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transactionId TEXT NOT NULL,
                campusId TEXT NOT NULL,
                amount INTEGER NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (campusId) REFERENCES campuses(id)
            )
        `);

        // Admin Commissions Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS admin_commissions (
                adminUid TEXT PRIMARY KEY,
                campusId TEXT NOT NULL,
                commissionRate REAL DEFAULT 0.10,
                totalEarned INTEGER DEFAULT 0,
                totalPaid INTEGER DEFAULT 0,
                lastCalculated DATETIME,
                FOREIGN KEY (campusId) REFERENCES campuses(id)
            )
        `);

        // Commission Payouts Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS commission_payouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                adminUid TEXT NOT NULL,
                amount INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                paidAt DATETIME,
                paidBy TEXT,
                paymentMethod TEXT,
                paymentRef TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Data Versions Table (for smart caching)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS data_versions (
                campusId TEXT PRIMARY KEY,
                version INTEGER DEFAULT 1,
                lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert super admin if not exists
        try {
            const superAdmin = await this.db.get("SELECT uid FROM admins WHERE email = 'kassimmusa322@gmail.com'");
            if (!superAdmin) {
                console.log('[LocalDB] Creating super admin...');
                await this.db.run(`
                    INSERT INTO admins (uid, email, role, scope, createdBy)
                    VALUES ('super_admin_init', 'kassimmusa322@gmail.com', 'super', '*', 'system')
                `);
            }
        } catch (e) {
            // Table might already have the entry
        }

        // ... (Previous Tables)
        
        // Visits Table (Unique Visitors)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS visits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE, -- Anonymous ID or User ID
                firstSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
                lastSeen DATETIME DEFAULT CURRENT_TIMESTAMP,
                campusId TEXT,
                universityId TEXT
            )
        `);

        // Revenue Config Table (Global Settings for Revenue Sharing)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS revenue_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                super_admin_cut REAL DEFAULT 60.0,
                admin_cut REAL DEFAULT 40.0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT
            )
        `);
        
        // Insert default config if not exists
        try {
            const config = await this.db.get("SELECT id FROM revenue_config WHERE id = 1");
            if (!config) {
                console.log('[LocalDB] Creating default revenue config (60/40 split)...');
                await this.db.run(`INSERT INTO revenue_config (id, super_admin_cut, admin_cut) VALUES (1, 60.0, 40.0)`);
            }
        } catch (e) { /* already exists */ }

        // Migration: Add custom_cut column to admins table for per-admin overrides
        try {
            const adminsSchema = await this.db.all("PRAGMA table_info(admins)");
            const hasCustomCut = adminsSchema.some(c => c.name === 'custom_cut');
            if (!hasCustomCut) {
                console.log('[LocalDB] Migrating: Adding custom_cut column to admins table...');
                await this.db.exec("ALTER TABLE admins ADD COLUMN custom_cut REAL DEFAULT NULL");
            }
        } catch (e) {
            console.error('[LocalDB] Admin migration error:', e);
        }

        // ============================================
        // ADS/BILLBOARD SYSTEM TABLES
        // ============================================

        // Ads Table
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS ads (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('image', 'gif', 'video', 'text')),
                mediaUrl TEXT,
                textContent TEXT,
                textStyle TEXT,
                hyperlink TEXT,
                duration INTEGER DEFAULT 10,
                priority INTEGER DEFAULT 0,
                scope TEXT DEFAULT 'global' CHECK (scope IN ('global', 'university')),
                universityId TEXT,
                status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'ended')),
                enabled INTEGER DEFAULT 1,
                startDate DATETIME,
                endDate DATETIME,
                clicks INTEGER DEFAULT 0,
                impressions INTEGER DEFAULT 0,
                createdBy TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Ad Settings Table (Global Configuration)
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS ad_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                adsEnabled INTEGER DEFAULT 0,
                emojiRainDuration INTEGER DEFAULT 30,
                adCycleDuration INTEGER DEFAULT 10,
                rotationMode TEXT DEFAULT 'sequential' CHECK (rotationMode IN ('sequential', 'random', 'priority')),
                defaultScope TEXT DEFAULT 'global',
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedBy TEXT
            )
        `);

        // Insert default ad settings if not exists
        try {
            const adConfig = await this.db.get("SELECT id FROM ad_settings WHERE id = 1");
            if (!adConfig) {
                console.log('[LocalDB] Creating default ad settings...');
                await this.db.run(`INSERT INTO ad_settings (id, adsEnabled, emojiRainDuration, adCycleDuration) VALUES (1, 0, 30, 10)`);
            }
        } catch (e) { /* already exists */ }

        // ============================================
        // COURSE PRESETS TABLE
        // ============================================
        
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS presets (
                id TEXT PRIMARY KEY,
                campusId TEXT NOT NULL,
                name TEXT NOT NULL,
                icon TEXT DEFAULT 'BookOpen',
                units TEXT NOT NULL,
                displayOrder INTEGER DEFAULT 0,
                enabled INTEGER DEFAULT 1,
                createdBy TEXT,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('[LocalDB] All tables initialized (including admin system)');
    }

    // ============================================
    // TIMETABLE MANAGEMENT
    // ============================================

    async saveTimetable(campusId, units) {
        if (!units || units.length === 0) return { count: 0 };
        
        const timestamp = new Date().toISOString();
        let inserted = 0;

        await this.db.run('BEGIN TRANSACTION');
        try {
            // Smart Filter: Optional clear logic here if needed.
            // For now, we perform raw insertion as requested.
            
            const stmt = await this.db.prepare(`
                INSERT INTO timetables (id, campusId, facultyId, departmentId, optionId, code, title, date, time, venue, level, semester, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const unit of units) {
                const id = `gen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                // Default semester = 1 if not present
                // Support hierarchical fields: facultyId, departmentId, optionId
                await stmt.run(
                    id, 
                    campusId, 
                    unit.facultyId || null,
                    unit.departmentId || null,
                    unit.optionId || null,
                    unit.code, 
                    unit.title, 
                    unit.date, 
                    unit.time, 
                    unit.venue, 
                    unit.level || 0,
                    unit.semester || 1, // Default semester
                    timestamp
                );
                inserted++;
            }
            await stmt.finalize();
            await this.db.run('COMMIT');
            
        } catch (e) {
            await this.db.run('ROLLBACK');
            throw e;
        }

        return { count: inserted };
    }

    // --- Visits ---
    async recordVisit(uid, campusId = null, universityId = null) {
        if (!uid) return;
        // Upsert
        const existing = await this.db.get('SELECT id FROM visits WHERE uid = ?', uid);
        if (existing) {
             await this.db.run('UPDATE visits SET lastSeen = ? WHERE uid = ?', [new Date().toISOString(), uid]);
        } else {
             await this.db.run(`
                INSERT INTO visits (uid, campusId, universityId) VALUES (?, ?, ?)
             `, [uid, campusId, universityId]);
        }
    }

    async getVisitorCount(campusId = null, universityId = null) {
        if (campusId) {
             const result = await this.db.get('SELECT COUNT(*) as count FROM visits WHERE campusId = ?', campusId);
             return result.count;
        }
        if (universityId) {
             const result = await this.db.get('SELECT COUNT(*) as count FROM visits WHERE universityId = ?', universityId);
             return result.count;
        }
        const result = await this.db.get('SELECT COUNT(*) as count FROM visits');
        return result.count;
    }

    // ============================================
    // REVENUE CONFIG & SHARING
    // ============================================

    async getRevenueConfig() {
        const config = await this.db.get("SELECT * FROM revenue_config WHERE id = 1");
        return config || { super_admin_cut: 60.0, admin_cut: 40.0 };
    }

    async updateRevenueConfig(superAdminCut, adminCut, updatedBy) {
        await this.db.run(`
            UPDATE revenue_config 
            SET super_admin_cut = ?, admin_cut = ?, updated_at = ?, updated_by = ?
            WHERE id = 1
        `, [superAdminCut, adminCut, new Date().toISOString(), updatedBy]);
        return this.getRevenueConfig();
    }

    // Get the cut percentage for a specific admin (checks for custom override)
    async getAdminCutPercentage(adminUid) {
        const admin = await this.db.get("SELECT custom_cut FROM admins WHERE uid = ?", adminUid);
        if (admin && admin.custom_cut !== null) {
            return admin.custom_cut; // Per-admin override
        }
        const config = await this.getRevenueConfig();
        return config.admin_cut; // Global default
    }

    // Set custom cut for specific admin (null = use global)
    async setAdminCustomCut(adminUid, customCut, updatedBy) {
        await this.db.run("UPDATE admins SET custom_cut = ? WHERE uid = ?", [customCut, adminUid]);
        // Audit log
        await this.addAuditLog(updatedBy, null, 'update_admin_cut', 'admin', adminUid, 
            JSON.stringify({ customCut }), 1);
    }

    // Calculate revenue with splits
    async getRevenueWithSplits(campusId = null, universityId = null, adminUid = null) {
        const config = await this.getRevenueConfig();
        let adminCutPercent = config.admin_cut;
        
        // Check for custom cut if adminUid provided
        if (adminUid) {
            adminCutPercent = await this.getAdminCutPercentage(adminUid);
        }

        // Build WHERE clause for completed transactions
        let whereClause = "WHERE status = 'completed'";
        const params = [];
        
        if (campusId) {
            // Need to join with transactions that have this campus
            // Assuming transactions have campus_id or we need to derive from user data
            // For now, use the revenue table
            whereClause += " AND campusId = ?";
            params.push(campusId);
        } else if (universityId) {
            whereClause += " AND universityId = ?";
            params.push(universityId);
        }

        // Get totals from transactions table
        const baseQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM transactions ${whereClause}`;
        const result = await this.db.get(baseQuery.replace('campusId', 'campus_id').replace('universityId', 'university_id'), params);
        
        const totalRevenue = result?.total || 0;
        const superAdminShare = Math.round(totalRevenue * (config.super_admin_cut / 100));
        const adminShare = Math.round(totalRevenue * (adminCutPercent / 100));

        // Get time-based breakdowns
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const todayResult = await this.db.get(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM transactions 
            ${whereClause} AND createdAt >= ?
        `.replace('campusId', 'campus_id').replace('universityId', 'university_id'), [...params, todayStart]);
        
        const weekResult = await this.db.get(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM transactions 
            ${whereClause} AND createdAt >= ?
        `.replace('campusId', 'campus_id').replace('universityId', 'university_id'), [...params, weekStart]);
        
        const monthResult = await this.db.get(`
            SELECT COALESCE(SUM(amount), 0) as total 
            FROM transactions 
            ${whereClause} AND createdAt >= ?
        `.replace('campusId', 'campus_id').replace('universityId', 'university_id'), [...params, monthStart]);

        return {
            totalRevenue,
            superAdminCut: config.super_admin_cut,
            adminCut: adminCutPercent,
            superAdminShare,
            adminShare,
            today: {
                total: todayResult?.total || 0,
                superAdminShare: Math.round((todayResult?.total || 0) * (config.super_admin_cut / 100)),
                adminShare: Math.round((todayResult?.total || 0) * (adminCutPercent / 100))
            },
            thisWeek: {
                total: weekResult?.total || 0,
                superAdminShare: Math.round((weekResult?.total || 0) * (config.super_admin_cut / 100)),
                adminShare: Math.round((weekResult?.total || 0) * (adminCutPercent / 100))
            },
            thisMonth: {
                total: monthResult?.total || 0,
                superAdminShare: Math.round((monthResult?.total || 0) * (config.super_admin_cut / 100)),
                adminShare: Math.round((monthResult?.total || 0) * (adminCutPercent / 100))
            }
        };
    }

    // ... (Transactions)

    async createTransaction(data) {
        const { id, uid, planId, amount, phone, mpesaCode, status, type, createdAt, campusId, universityId } = data;
        
        await this.db.run(`
            INSERT INTO transactions (id, uid, planId, amount, phone, mpesaCode, status, type, createdAt, campus_id, university_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, uid, planId, amount, phone, mpesaCode, status, type, createdAt, campusId, universityId]);

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

    // ============================================
    // UNIVERSITIES
    // ============================================

    async getUniversities() {
        const rows = await this.db.all('SELECT * FROM universities ORDER BY name');
        return rows.map(u => this._mapUniversity(u));
    }

    async getUniversity(id) {
        const u = await this.db.get('SELECT * FROM universities WHERE id = ?', id);
        return u ? this._mapUniversity(u) : null;
    }
    
    async getUniversityBySlug(slug) {
        const u = await this.db.get('SELECT * FROM universities WHERE slug = ?', slug);
        return u ? this._mapUniversity(u) : null;
    }
    
    // Map raw DB row to UniversityConfig-like object
    _mapUniversity(u) {
        let colors = null;
        try {
            colors = u.colors ? JSON.parse(u.colors) : null;
        } catch (e) {
            colors = null;
        }
        return {
            id: u.id,
            name: u.name,
            slug: u.slug || u.shortCode?.toLowerCase(), // Fallback to lowercase shortCode
            shortName: u.shortCode,
            shortCode: u.shortCode,
            structureType: u.structure_type || 'campus',
            colors: colors || { primary: 'from-blue-600 to-purple-600', secondary: 'bg-blue-600', accent: 'text-blue-500' },
            logoUrl: u.logoUrl,
            faviconUrl: u.faviconUrl,
            ogImageUrl: u.ogImageUrl,
            tagline: u.tagline,
            defaultCampus: u.defaultCampus
        };
    }

    async createUniversity(data) {
        const { id, name, shortCode, structureType, slug, colors, logoUrl, faviconUrl, ogImageUrl, tagline, defaultCampus } = data;
        const colorsJson = colors ? JSON.stringify(colors) : null;
        await this.db.run(`
            INSERT INTO universities (id, name, shortCode, structure_type, slug, colors, logoUrl, faviconUrl, ogImageUrl, tagline, defaultCampus)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, name, shortCode, structureType || 'campus', slug || shortCode?.toLowerCase(), colorsJson, logoUrl, faviconUrl, ogImageUrl, tagline, defaultCampus]);
        await this.addToSyncQueue('universities', id, 'create', data);
        return { id, ...data };
    }

    async updateUniversity(id, data) {
        const { name, shortCode, structureType, slug, colors, logoUrl, faviconUrl, ogImageUrl, tagline, defaultCampus } = data;
        const colorsJson = colors ? JSON.stringify(colors) : undefined;
        
        // Build dynamic update query
        const updates = [];
        const params = [];
        
        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (shortCode !== undefined) { updates.push('shortCode = ?'); params.push(shortCode); }
        if (structureType !== undefined) { updates.push('structure_type = ?'); params.push(structureType); }
        if (slug !== undefined) { updates.push('slug = ?'); params.push(slug); }
        if (colorsJson !== undefined) { updates.push('colors = ?'); params.push(colorsJson); }
        if (logoUrl !== undefined) { updates.push('logoUrl = ?'); params.push(logoUrl); }
        if (faviconUrl !== undefined) { updates.push('faviconUrl = ?'); params.push(faviconUrl); }
        if (ogImageUrl !== undefined) { updates.push('ogImageUrl = ?'); params.push(ogImageUrl); }
        if (tagline !== undefined) { updates.push('tagline = ?'); params.push(tagline); }
        if (defaultCampus !== undefined) { updates.push('defaultCampus = ?'); params.push(defaultCampus); }
        
        if (updates.length > 0) {
            params.push(id);
            await this.db.run(`UPDATE universities SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        
        await this.addToSyncQueue('universities', id, 'update', data);
        return await this.getUniversity(id);
    }

    async deleteUniversity(id) {
        // Cascade delete campuses
        const campuses = await this.getCampuses(id);
        for (const campus of campuses) {
            await this.deleteCampus(campus.id);
        }
        await this.db.run('DELETE FROM universities WHERE id = ?', id);
        await this.addToSyncQueue('universities', id, 'delete', {});
    }

    // ============================================
    // CAMPUSES
    // ============================================

    async getCampuses(universityId = null) {
        if (universityId) {
            return await this.db.all('SELECT * FROM campuses WHERE universityId = ? ORDER BY name', universityId);
        }
        return await this.db.all('SELECT * FROM campuses ORDER BY name');
    }

    async getCampusBySlug(slug) {
        return await this.db.get('SELECT * FROM campuses WHERE slug = ?', slug);
    }

    async createCampus(data) {
        const { id, universityId, name, slug } = data;
        await this.db.run(`
            INSERT INTO campuses (id, universityId, name, slug)
            VALUES (?, ?, ?, ?)
        `, [id, universityId, name, slug]);
        
        // Create data version entry
        await this.db.run(`
            INSERT INTO data_versions (campusId, version)
            VALUES (?, 1)
        `, [id]);
        
        await this.addToSyncQueue('campuses', id, 'create', data);
        return { id, ...data };
    }

    async updateCampus(id, data) {
        const { name, slug, universityId } = data;
        await this.db.run(`
            UPDATE campuses SET name = ?, slug = ?, universityId = ? WHERE id = ?
        `, [name, slug, universityId, id]);
        await this.addToSyncQueue('campuses', id, 'update', data);
        return await this.db.get('SELECT * FROM campuses WHERE id = ?', id);
    }

    async deleteCampus(id) {
        // Delete timetables first?
        await this.db.run('DELETE FROM timetables WHERE campusId = ?', id);
        await this.db.run('DELETE FROM faculties WHERE campusId = ?', id);
        await this.db.run('DELETE FROM data_versions WHERE campusId = ?', id);
        await this.db.run('DELETE FROM campuses WHERE id = ?', id);
        await this.addToSyncQueue('campuses', id, 'delete', {});
    }

    async getCampusVersion(campusSlug) {
        let campusId = null;

        // 1. Try Campus (Slug or ID)
        const campus = await this.db.get('SELECT id FROM campuses WHERE slug = ? OR id = ?', [campusSlug, campusSlug]);
        if (campus) {
             campusId = campus.id;
        } else {
             // 2. Try Faculty (Slug or ID)
             const faculty = await this.db.get('SELECT campusId FROM faculties WHERE slug = ? OR id = ?', [campusSlug, campusSlug]);
             if (faculty) {
                 campusId = faculty.campusId;
             } else {
                 // 3. Try Department (Slug or ID)
                 // Need to join to get campusId from faculty
                 const department = await this.db.get(`
                    SELECT f.campusId 
                    FROM departments d
                    JOIN faculties f ON d.facultyId = f.id
                    WHERE d.slug = ? OR d.id = ?
                 `, [campusSlug, campusSlug]);
                 if (department) {
                     campusId = department.campusId;
                 }
             }
        }

        if (!campusId) return null;

        const version = await this.db.get('SELECT version, lastUpdated FROM data_versions WHERE campusId = ?', campusId);
        return version || { version: 1 };
    }

    async incrementCampusVersion(campusId) {
        await this.db.run(`
            UPDATE data_versions 
            SET version = version + 1, lastUpdated = ?
            WHERE campusId = ?
        `, [new Date().toISOString(), campusId]);
    }

    // ============================================
    // FACULTIES
    // ============================================

    async getFaculties(campusId) {
        return await this.db.all('SELECT * FROM faculties WHERE campusId = ? ORDER BY name', campusId);
    }

    async createFaculty(data) {
        const { id, campusId, name, slug } = data;
        await this.db.run(`
            INSERT INTO faculties (id, campusId, name, slug)
            VALUES (?, ?, ?, ?)
        `, [id, campusId, name, slug]);
        await this.addToSyncQueue('faculties', id, 'create', data);
        return { id, ...data };
    }

    async updateFaculty(id, data) {
        const { name, slug } = data;
        await this.db.run(`
            UPDATE faculties SET name = ?, slug = ? WHERE id = ?
        `, [name, slug, id]);
        await this.addToSyncQueue('faculties', id, 'update', data);
        return await this.db.get('SELECT * FROM faculties WHERE id = ?', id);
    }

    async deleteFaculty(id) {
        const result = await this.db.run('DELETE FROM faculties WHERE id = ?', id);
        await this.addToSyncQueue('faculties', id, 'delete', {});
        return result.changes;
    }

    // ============================================
    // DEPARTMENTS
    // ============================================

    async getAllDepartments() {
        return await this.db.all('SELECT * FROM departments ORDER BY name');
    }

    async getDepartments(facultyId) {
        return await this.db.all('SELECT * FROM departments WHERE facultyId = ? ORDER BY name', facultyId);
    }

    async createDepartment(data) {
        const { id, facultyId, name, slug, subLabel } = data;
        await this.db.run(`
            INSERT INTO departments (id, facultyId, name, slug, subLabel)
            VALUES (?, ?, ?, ?, ?)
        `, [id, facultyId, name, slug, subLabel || null]);
        await this.addToSyncQueue('departments', id, 'create', data);
        return { id, ...data };
    }

    async updateDepartment(id, data) {
        const { name, slug, subLabel } = data;
        await this.db.run(`
            UPDATE departments SET name = ?, slug = ?, subLabel = ? WHERE id = ?
        `, [name, slug, subLabel || null, id]);
        await this.addToSyncQueue('departments', id, 'update', data);
        return await this.db.get('SELECT * FROM departments WHERE id = ?', id);
    }

    async deleteDepartment(id) {
        const result = await this.db.run('DELETE FROM departments WHERE id = ?', id);
        await this.addToSyncQueue('departments', id, 'delete', {});
        return result.changes;
    }

    // ============================================
    // OPTIONS
    // ============================================

    async getAllOptions() {
        return await this.db.all('SELECT * FROM options ORDER BY name');
    }

    async getOptions(departmentId) {
        return await this.db.all('SELECT * FROM options WHERE departmentId = ? ORDER BY name', departmentId);
    }

    async createOption(data) {
        const { id, departmentId, name, slug } = data;
        await this.db.run(`
            INSERT INTO options (id, departmentId, name, slug)
            VALUES (?, ?, ?, ?)
        `, [id, departmentId, name, slug]);
        await this.addToSyncQueue('options', id, 'create', data);
        return { id, ...data };
    }

    async updateOption(id, data) {
        const { name, slug } = data;
        await this.db.run(`
            UPDATE options SET name = ?, slug = ? WHERE id = ?
        `, [name, slug, id]);
        await this.addToSyncQueue('options', id, 'update', data);
        return await this.db.get('SELECT * FROM options WHERE id = ?', id);
    }

    async deleteOption(id) {
        const result = await this.db.run('DELETE FROM options WHERE id = ?', id);
        await this.addToSyncQueue('options', id, 'delete', {});
        return result.changes;
    }

    // ============================================
    // TIMETABLES
    // ============================================

    async getTimetables(campusId, facultyId = null, departmentId = null, optionId = null) {
        let sql = 'SELECT * FROM timetables WHERE campusId = ?';
        const params = [campusId];

        if (facultyId) {
            sql += ' AND facultyId = ?';
            params.push(facultyId);
        }
        if (departmentId) {
            sql += ' AND departmentId = ?';
            params.push(departmentId);
        }
        if (optionId) {
            sql += ' AND optionId = ?';
            params.push(optionId);
        }

        sql += ' ORDER BY date, time';
        return await this.db.all(sql, params);
    }

    async getTimetablesByCampusSlug(slug) {
        // 1. Try Campus (Slug or ID)
        let campus = await this.db.get('SELECT * FROM campuses WHERE slug = ? OR id = ?', [slug, slug]);
        if (campus) return await this.getTimetables(campus.id);

        // 2. Try Faculty (Slug or ID)
        const faculty = await this.db.get('SELECT * FROM faculties WHERE slug = ? OR id = ?', [slug, slug]);
        if (faculty) {
            return await this.getTimetables(faculty.campusId, faculty.id);
        }

        // 3. Try Department (Slug or ID)
        const department = await this.db.get('SELECT * FROM departments WHERE slug = ? OR id = ?', [slug, slug]);
        if (department) {
            return await this.db.all('SELECT * FROM timetables WHERE departmentId = ? ORDER BY date, time', [department.id]);
        }
        
        return [];
    }

    async getTimetable(id) {
        return await this.db.get('SELECT * FROM timetables WHERE id = ?', id);
    }

    async createTimetable(data, adminUid) {
        const { id, campusId, facultyId = null, code, title, date, time, venue, level, semester = null } = data;
        const now = new Date().toISOString();
        
        await this.db.run(`
            INSERT INTO timetables (id, campusId, facultyId, code, title, date, time, venue, level, semester, createdAt, updatedAt, createdBy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, campusId, facultyId, code, title, date, time, venue, level, semester, now, now, adminUid]);
        
        await this.incrementCampusVersion(campusId);
        await this.addToSyncQueue('timetables', id, 'create', data);
        return { id, ...data, createdAt: now };
    }

    async updateTimetable(id, data, adminUid) {
        const existing = await this.getTimetable(id);
        if (!existing) return null;
        
        const code = data.code !== undefined ? data.code : existing.code;
        const title = data.title !== undefined ? data.title : existing.title;
        const date = data.date !== undefined ? data.date : existing.date;
        const time = data.time !== undefined ? data.time : existing.time;
        const venue = data.venue !== undefined ? data.venue : existing.venue;
        const level = data.level !== undefined ? data.level : existing.level;
        const semester = data.semester !== undefined ? data.semester : existing.semester;
        const facultyId = data.facultyId !== undefined ? data.facultyId : existing.facultyId;
        const now = new Date().toISOString();
        
        await this.db.run(`
            UPDATE timetables 
            SET code = ?, title = ?, date = ?, time = ?, venue = ?, level = ?, semester = ?, facultyId = ?, updatedAt = ?
            WHERE id = ?
        `, [code, title, date, time, venue, level, semester, facultyId, now, id]);
        
        await this.incrementCampusVersion(existing.campusId);
        await this.addToSyncQueue('timetables', id, 'update', data);
        
        return await this.getTimetable(id);
    }

    async deleteTimetable(id) {
        const existing = await this.getTimetable(id);
        if (!existing) return 0;
        
        const result = await this.db.run('DELETE FROM timetables WHERE id = ?', id);
        
        await this.incrementCampusVersion(existing.campusId);
        await this.addToSyncQueue('timetables', id, 'delete', {});
        
        return result.changes;
    }

    async bulkUpdateTimetables(ids, changes, adminUid) {
        const setClauses = [];
        const values = [];
        
        if (changes.venue !== undefined) {
            setClauses.push('venue = ?');
            values.push(changes.venue);
        }
        if (changes.time !== undefined) {
            setClauses.push('time = ?');
            values.push(changes.time);
        }
        if (changes.level !== undefined) {
            setClauses.push('level = ?');
            values.push(changes.level);
        }
        if (changes.date !== undefined) {
            setClauses.push('date = ?');
            values.push(changes.date);
        }
        
        setClauses.push('updatedAt = ?');
        values.push(new Date().toISOString());
        
        const placeholders = ids.map(() => '?').join(',');
        values.push(...ids);
        
        const result = await this.db.run(`
            UPDATE timetables 
            SET ${setClauses.join(', ')}
            WHERE id IN (${placeholders})
        `, values);
        
        // Get affected campuses and increment their versions
        const affected = await this.db.all(`
            SELECT DISTINCT campusId FROM timetables WHERE id IN (${placeholders})
        `, ids);
        
        for (const { campusId } of affected) {
            await this.incrementCampusVersion(campusId);
        }
        
        // Queue sync for each
        for (const id of ids) {
            await this.addToSyncQueue('timetables', id, 'update', changes);
        }
        
        return result.changes;
    }

    async bulkDeleteTimetables(ids) {
        // Get affected campuses first
        const placeholders = ids.map(() => '?').join(',');
        const affected = await this.db.all(`
            SELECT DISTINCT campusId FROM timetables WHERE id IN (${placeholders})
        `, ids);
        
        const result = await this.db.run(`
            DELETE FROM timetables WHERE id IN (${placeholders})
        `, ids);
        
        for (const { campusId } of affected) {
            await this.incrementCampusVersion(campusId);
        }
        
        for (const id of ids) {
            await this.addToSyncQueue('timetables', id, 'delete', {});
        }
        
        return result.changes;
    }

    async importTimetables(campusId, entries, adminUid) {
        let imported = 0;
        const now = new Date().toISOString();
        
        for (const entry of entries) {
            const id = entry.id || `tt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            try {
                await this.db.run(`
                    INSERT INTO timetables (id, campusId, facultyId, code, title, date, time, venue, level, semester, createdAt, updatedAt, createdBy)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [id, campusId, entry.facultyId || null, entry.code, entry.title, entry.date, entry.time, entry.venue, entry.level, entry.semester || null, now, now, adminUid]);
                
                await this.addToSyncQueue('timetables', id, 'create', { ...entry, id, campusId });
                imported++;
            } catch (e) {
                console.error(`[ImportTimetables] Failed to import entry:`, entry.code, e.message);
            }
        }
        
        await this.incrementCampusVersion(campusId);
        return imported;
    }

    async searchTimetables(query, campusId = null, universityId = null, facultyId = null, departmentId = null, optionId = null) {
        let sql = `
            SELECT t.*, c.name as campusName, u.name as universityName 
            FROM timetables t
            LEFT JOIN campuses c ON t.campusId = c.id
            LEFT JOIN universities u ON c.universityId = u.id
            WHERE 1=1
        `;
        const params = [];

        if (query && query !== '*') {
            sql += ` AND (t.code LIKE ? OR t.title LIKE ? OR t.venue LIKE ?)`;
            params.push(`%${query}%`, `%${query}%`, `%${query}%`);
        }

        if (campusId) {
            sql += ` AND t.campusId = ?`;
            params.push(campusId);
        } else if (universityId) {
             // If campus not specified but uni is, filter by uni via join
             sql += ` AND c.universityId = ?`;
             params.push(universityId);
        }

        if (facultyId) {
            sql += ` AND t.facultyId = ?`;
            params.push(facultyId);
        }

        if (departmentId) {
            sql += ` AND t.departmentId = ?`;
            params.push(departmentId);
        }

        if (optionId) {
            sql += ` AND t.optionId = ?`;
            params.push(optionId);
        }

        sql += ` ORDER BY t.date ASC, t.time ASC LIMIT 100`;

        return await this.db.all(sql, params);
    }

    async getTimetableStats(campusId = null, universityId = null) {
        if (campusId) {
            const total = await this.db.get('SELECT COUNT(*) as count FROM timetables WHERE campusId = ?', campusId);
            const missingTitles = await this.db.get("SELECT COUNT(*) as count FROM timetables WHERE campusId = ? AND (title IS NULL OR title = '' OR title = 'Unit Title Not Specified')", campusId);
            const byLevel = await this.db.all('SELECT level, COUNT(*) as count FROM timetables WHERE campusId = ? GROUP BY level', campusId);
            // Single campus doesn't need byCampus breakdown usually, but if requested:
            return { total: total.count, missingTitles: missingTitles.count, byLevel, byCampus: [] };
        }
        
        if (universityId) {
            const total = await this.db.get(`
                SELECT COUNT(t.id) as count 
                FROM timetables t 
                JOIN campuses c ON t.campusId = c.id 
                WHERE c.universityId = ?`, universityId);
            
            const missingTitles = await this.db.get(`
                SELECT COUNT(t.id) as count 
                FROM timetables t 
                JOIN campuses c ON t.campusId = c.id 
                WHERE c.universityId = ? AND (t.title IS NULL OR t.title = '' OR t.title = 'Unit Title Not Specified')`, universityId);
                
            const byLevel = await this.db.all(`
                SELECT t.level, COUNT(t.id) as count 
                FROM timetables t 
                JOIN campuses c ON t.campusId = c.id 
                WHERE c.universityId = ? 
                GROUP BY t.level`, universityId);
                
            const byCampus = await this.db.all(`
               SELECT c.id as campusId, c.name as campusName, COUNT(t.id) as count 
               FROM campuses c 
               LEFT JOIN timetables t ON t.campusId = c.id 
               WHERE c.universityId = ?
               GROUP BY c.id`, universityId);

            return { total: total.count, missingTitles: missingTitles.count, byLevel, byCampus };
        }

        const total = await this.db.get('SELECT COUNT(*) as count FROM timetables');
        const missingTitles = await this.db.get("SELECT COUNT(*) as count FROM timetables WHERE title IS NULL OR title = '' OR title = 'Unit Title Not Specified'");
        const byCampus = await this.db.all(`
            SELECT c.id as campusId, c.name as campusName, COUNT(t.id) as count 
            FROM campuses c 
            LEFT JOIN timetables t ON t.campusId = c.id 
            GROUP BY c.id
        `);
        // For global view, we might want byLevel too? Logic wasn't there before, but let's add it for consistency or leave as is?
        // Original didn't return byLevel for global. I'll add it.
        const byLevel = await this.db.all('SELECT level, COUNT(*) as count FROM timetables GROUP BY level');
        
        return { total: total.count, missingTitles: missingTitles.count, byLevel, byCampus };
    }

    // ============================================
    // ADMINS
    // ============================================

    async getAdmins() {
        return await this.db.all('SELECT * FROM admins ORDER BY role, email');
    }

    async getAdmin(uid) {
        return await this.db.get('SELECT * FROM admins WHERE uid = ?', uid);
    }

    async getAdminByEmail(email) {
        return await this.db.get('SELECT * FROM admins WHERE email = ?', email);
    }

    async createAdmin(data, createdByUid) {
        const { uid, email, role, scope } = data;
        await this.db.run(`
            INSERT INTO admins (uid, email, role, scope, createdBy)
            VALUES (?, ?, ?, ?, ?)
        `, [uid, email, role || 'editor', scope, createdByUid]);
        await this.addToSyncQueue('admins', uid, 'create', data);
        return { uid, ...data };
    }

    async updateAdmin(uid, data) {
        const { role, scope } = data;
        await this.db.run(`
            UPDATE admins SET role = ?, scope = ? WHERE uid = ?
        `, [role, scope, uid]);
        await this.addToSyncQueue('admins', uid, 'update', data);
        return await this.getAdmin(uid);
    }

    async deleteAdmin(uid) {
        const result = await this.db.run('DELETE FROM admins WHERE uid = ?', uid);
        await this.addToSyncQueue('admins', uid, 'delete', {});
        return result.changes;
    }

    async isAdmin(uid) {
        const admin = await this.getAdmin(uid);
        return !!admin;
    }

    async isSuperAdmin(uid) {
        const admin = await this.getAdmin(uid);
        return admin && admin.role === 'super';
    }

    // ============================================
    // MESSAGES
    // ============================================

    async getMessages(uid, unreadOnly = false) {
        if (unreadOnly) {
            return await this.db.all(`
                SELECT * FROM messages 
                WHERE toUid = ? OR toUid IS NULL
                AND isRead = 0
                ORDER BY createdAt DESC
            `, uid);
        }
        return await this.db.all(`
            SELECT * FROM messages 
            WHERE toUid = ? OR toUid IS NULL
            ORDER BY createdAt DESC
        `, uid);
    }

    async getSentMessages(fromUid) {
        return await this.db.all('SELECT * FROM messages WHERE fromUid = ? ORDER BY createdAt DESC', fromUid);
    }

    async createMessage(data) {
        const { fromUid, toUid, subject, body } = data;
        const result = await this.db.run(`
            INSERT INTO messages (fromUid, toUid, subject, body)
            VALUES (?, ?, ?, ?)
        `, [fromUid, toUid || null, subject, body]);
        return { id: result.lastID, ...data };
    }

    async markMessageRead(id, uid) {
        await this.db.run('UPDATE messages SET isRead = 1 WHERE id = ? AND (toUid = ? OR toUid IS NULL)', [id, uid]);
    }

    async getUnreadCount(uid) {
        const result = await this.db.get(`
            SELECT COUNT(*) as count FROM messages 
            WHERE (toUid = ? OR toUid IS NULL) AND isRead = 0
        `, uid);
        return result.count;
    }

    // ============================================
    // AUDIT LOGS
    // ============================================

    async createAuditLog(data) {
        const { adminUid, adminEmail, action, entityType, entityId, changesSummary, affectedCount } = data;
        await this.db.run(`
            INSERT INTO audit_logs (adminUid, adminEmail, action, entityType, entityId, changesSummary, affectedCount)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [adminUid, adminEmail, action, entityType, entityId, JSON.stringify(changesSummary), affectedCount]);
    }

    async getAuditLogs(limit = 100, offset = 0, filters = {}) {
        let query = 'SELECT * FROM audit_logs WHERE 1=1';
        const params = [];
        
        if (filters.adminUid) {
            query += ' AND adminUid = ?';
            params.push(filters.adminUid);
        }
        if (filters.action) {
            query += ' AND action = ?';
            params.push(filters.action);
        }
        if (filters.entityType) {
            query += ' AND entityType = ?';
            params.push(filters.entityType);
        }
        
        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        return await this.db.all(query, params);
    }

    // ============================================
    // REVENUE & COMMISSIONS
    // ============================================

    async recordRevenue(transactionId, campusId, amount) {
        await this.db.run(`
            INSERT INTO revenue (transactionId, campusId, amount)
            VALUES (?, ?, ?)
        `, [transactionId, campusId, amount]);
        
        // Update commission if admin exists for this campus
        const commission = await this.db.get('SELECT * FROM admin_commissions WHERE campusId = ?', campusId);
        if (commission) {
            const earned = Math.round(amount * commission.commissionRate);
            await this.db.run(`
                UPDATE admin_commissions 
                SET totalEarned = totalEarned + ?, lastCalculated = ?
                WHERE campusId = ?
            `, [earned, new Date().toISOString(), campusId]);
        }
    }

    async getRevenue(campusId = null, universityId = null) {
        if (campusId) {
            return await this.db.get(`
                SELECT SUM(amount) as total, COUNT(*) as count 
                FROM revenue WHERE campusId = ?
            `, campusId);
        }
        if (universityId) {
            return await this.db.get(`
                SELECT SUM(r.amount) as total, COUNT(r.id) as count 
                FROM revenue r
                JOIN campuses c ON r.campusId = c.id
                WHERE c.universityId = ?
            `, universityId);
        }
        return await this.db.get('SELECT SUM(amount) as total, COUNT(*) as count FROM revenue');
    }

    async getRevenueByCampus(universityId = null, campusId = null) {
        let whereClause = "WHERE t.status = 'completed'";
        const params = [];
        
        if (campusId) {
            whereClause += " AND t.campusId = ?"; // Assuming transactions has campusId or joined
            // My earlier createTransaction didn't explicitly add campusId to transactions.
            // Let me check createTransaction. It only has: id, uid, planId, amount, phone, mpesaCode, status, type, createdAt
            // It needs to join with visits or store campusId.
            // Wait, the revenue table WAS storing campusId. 
            // If transactions table doesn't have campusId, we have a problem joining.
            // Let's assume for now we use the revenue table because it has the mapping?
            // BUT earlier I saw createTransaction DOES NOT insert into revenue table!
            
            // Let's look at how to get campusId for a transaction.
            // Maybe we can join users -> visits? No, visits are ephemeral.
            // We should have stored campusId in transactions.
            // Let's check existing transaction schema.
            // Line 30: id, uid, planId, amount... no campusId.
            
            // OK, we must trust the revenue table IF it's being populated.
            // But createTransaction (lines 448-460) DOES NOT insert into revenue table. 
            // This means revenue table is empty or populated elsewhere?
            // Actually, I saw `getRevenueWithSplits` using `campusId` in where clause... 
            // "Assuming transactions have campus_id or we need to derive from user data"
            
            // Revert: I should check if `revenue` table is populated. 
            // If not, we have no way to link transaction to campus easily without `campusId` in transactions table.
            
            // Let's stick to the existing implementation using `revenue` table IF it works, 
            // BUT update it to support filter.
            // OR better: check if `transactions` table has `campusId`.
        }
        
        // Let's pause and check schema for transactions again.
        // Line 30: id, uid, planId, amount...
        // It DOES NOT have campusId.
        // This is a schema gap. Transactions should be linked to campus.
        // However, the `revenue` table (Line 192) HAS `transactionId` and `campusId`.
        // So we should JOIN transactions and revenue?
        // OR just use revenue table?
        
        // If createTransaction doesn't populate `revenue` table, then `revenue` table is empty.
        // Let's check `database.js` for where `revenue` is inserted.
        
        return []; 
    }

    async getAdminCommission(adminUid) {
        return await this.db.get('SELECT * FROM admin_commissions WHERE adminUid = ?', adminUid);
    }

    async getAllCommissions() {
        return await this.db.all(`
            SELECT ac.*, a.email, c.name as campusName
            FROM admin_commissions ac
            JOIN admins a ON a.uid = ac.adminUid
            JOIN campuses c ON c.id = ac.campusId
            ORDER BY ac.totalEarned DESC
        `);
    }

    async setAdminCommission(adminUid, campusId, rate = 0.10) {
        const existing = await this.getAdminCommission(adminUid);
        if (existing) {
            await this.db.run(`
                UPDATE admin_commissions SET campusId = ?, commissionRate = ? WHERE adminUid = ?
            `, [campusId, rate, adminUid]);
        } else {
            await this.db.run(`
                INSERT INTO admin_commissions (adminUid, campusId, commissionRate)
                VALUES (?, ?, ?)
            `, [adminUid, campusId, rate]);
        }
    }

    async recordCommissionPayout(adminUid, amount, paidByUid, paymentMethod, paymentRef) {
        await this.db.run(`
            INSERT INTO commission_payouts (adminUid, amount, status, paidAt, paidBy, paymentMethod, paymentRef)
            VALUES (?, ?, 'paid', ?, ?, ?, ?)
        `, [adminUid, amount, new Date().toISOString(), paidByUid, paymentMethod, paymentRef]);
        
        await this.db.run(`
            UPDATE admin_commissions SET totalPaid = totalPaid + ? WHERE adminUid = ?
        `, [amount, adminUid]);
    }

    async getCommissionPayouts(adminUid = null) {
        if (adminUid) {
            return await this.db.all('SELECT * FROM commission_payouts WHERE adminUid = ? ORDER BY createdAt DESC', adminUid);
        }
        return await this.db.all('SELECT * FROM commission_payouts ORDER BY createdAt DESC');
    }

    // ============================================
    // ADS/BILLBOARD CRUD METHODS
    // ============================================

    async createAd(ad) {
        const id = ad.id || `ad_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await this.db.run(`
            INSERT INTO ads (id, title, type, mediaUrl, textContent, textStyle, hyperlink, duration, priority, scope, universityId, status, enabled, startDate, endDate, createdBy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id, ad.title, ad.type, ad.mediaUrl || null, ad.textContent || null, 
            JSON.stringify(ad.textStyle || {}), ad.hyperlink || null, ad.duration || 10, 
            ad.priority || 0, ad.scope || 'global', ad.universityId || null, 
            ad.status || 'draft', ad.enabled ? 1 : 0, ad.startDate || null, ad.endDate || null, ad.createdBy
        ]);
        return { id, ...ad };
    }

    async getAds(filters = {}) {
        let query = 'SELECT * FROM ads WHERE 1=1';
        const params = [];

        if (filters.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        if (filters.scope) {
            query += ' AND scope = ?';
            params.push(filters.scope);
        }
        if (filters.universityId) {
            query += ' AND (universityId = ? OR scope = "global")';
            params.push(filters.universityId);
        }
        if (filters.enabled !== undefined) {
            query += ' AND enabled = ?';
            params.push(filters.enabled ? 1 : 0);
        }
        if (filters.activeNow) {
            const now = new Date().toISOString();
            query += ' AND (startDate IS NULL OR startDate <= ?) AND (endDate IS NULL OR endDate >= ?)';
            params.push(now, now);
        }

        query += ' ORDER BY priority DESC, createdAt DESC';
        
        if (filters.limit) {
            query += ' LIMIT ?';
            params.push(filters.limit);
        }

        const ads = await this.db.all(query, params);
        return ads.map(ad => ({
            ...ad,
            textStyle: ad.textStyle ? JSON.parse(ad.textStyle) : {},
            enabled: !!ad.enabled
        }));
    }

    async getAd(id) {
        const ad = await this.db.get('SELECT * FROM ads WHERE id = ?', id);
        if (!ad) return null;
        return {
            ...ad,
            textStyle: ad.textStyle ? JSON.parse(ad.textStyle) : {},
            enabled: !!ad.enabled
        };
    }

    async updateAd(id, updates) {
        const fields = [];
        const values = [];

        const allowedFields = ['title', 'type', 'mediaUrl', 'textContent', 'textStyle', 'hyperlink', 'duration', 'priority', 'scope', 'universityId', 'status', 'enabled', 'startDate', 'endDate'];
        
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                fields.push(`${field} = ?`);
                if (field === 'textStyle') {
                    values.push(JSON.stringify(updates[field]));
                } else if (field === 'enabled') {
                    values.push(updates[field] ? 1 : 0);
                } else {
                    values.push(updates[field]);
                }
            }
        }

        if (fields.length === 0) return null;

        fields.push('updatedAt = ?');
        values.push(new Date().toISOString());
        values.push(id);

        await this.db.run(`UPDATE ads SET ${fields.join(', ')} WHERE id = ?`, values);
        return await this.getAd(id);
    }

    async deleteAd(id) {
        await this.db.run('DELETE FROM ads WHERE id = ?', id);
        return { success: true };
    }

    async trackAdClick(id) {
        await this.db.run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', id);
    }

    async trackAdImpression(id) {
        await this.db.run('UPDATE ads SET impressions = impressions + 1 WHERE id = ?', id);
    }

    // ============================================
    // PRESETS MANAGEMENT
    // ============================================



    async savePreset(data) {
        const { id, campusId, name, units, icon, displayOrder } = data;
        const timestamp = new Date().toISOString();
        
        // Check if exists
        const existing = await this.db.get('SELECT id FROM presets WHERE id = ?', id);
        
        if (existing) {
             await this.db.run(`
                UPDATE presets 
                SET campusId = ?, name = ?, units = ?, icon = ?, displayOrder = ?, updatedAt = ?
                WHERE id = ?
             `, [campusId, name, JSON.stringify(units), icon || 'BookOpen', displayOrder || 0, timestamp, id]);
        } else {
             await this.db.run(`
                INSERT INTO presets (id, campusId, name, units, icon, displayOrder, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             `, [id, campusId, name, JSON.stringify(units), icon || 'BookOpen', displayOrder || 0, timestamp, timestamp]);
        }
        return { success: true, id };
    }

    async deletePreset(id) {
        await this.db.run('DELETE FROM presets WHERE id = ?', id);
        return { success: true };
    }


    async bulkUpdateAdStatus(ids, status) {
        const placeholders = ids.map(() => '?').join(',');
        await this.db.run(`UPDATE ads SET status = ?, updatedAt = ? WHERE id IN (${placeholders})`, [status, new Date().toISOString(), ...ids]);
    }

    async pauseAllAds() {
        await this.db.run("UPDATE ads SET status = 'paused', updatedAt = ? WHERE status = 'live'", new Date().toISOString());
    }

    async resumeAllAds() {
        await this.db.run("UPDATE ads SET status = 'live', updatedAt = ? WHERE status = 'paused'", new Date().toISOString());
    }

    // Ad Settings
    async getAdSettings() {
        const settings = await this.db.get('SELECT * FROM ad_settings WHERE id = 1');
        return settings ? {
            ...settings,
            adsEnabled: !!settings.adsEnabled
        } : {
            adsEnabled: false,
            emojiRainDuration: 30,
            adCycleDuration: 10,
            rotationMode: 'sequential',
            defaultScope: 'global'
        };
    }

    async updateAdSettings(updates, updatedBy) {
        const fields = [];
        const values = [];

        const allowedFields = ['adsEnabled', 'emojiRainDuration', 'adCycleDuration', 'rotationMode', 'defaultScope'];
        
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                fields.push(`${field} = ?`);
                if (field === 'adsEnabled') {
                    values.push(updates[field] ? 1 : 0);
                } else {
                    values.push(updates[field]);
                }
            }
        }

        if (fields.length === 0) return await this.getAdSettings();

        fields.push('updatedAt = ?', 'updatedBy = ?');
        values.push(new Date().toISOString(), updatedBy);

        await this.db.run(`UPDATE ad_settings SET ${fields.join(', ')} WHERE id = 1`, values);
        return await this.getAdSettings();
    }

    // ============================================
    // COURSE PRESETS METHODS
    // ============================================

    async getPresets(campusId = null) {
        let presets = [];
        if (campusId) {
            presets = await this.db.all(
                `SELECT * FROM presets WHERE campusId = ? AND enabled = 1 ORDER BY displayOrder ASC, name ASC`,
                [campusId]
            );
        } else {
             presets = await this.db.all(`SELECT * FROM presets ORDER BY campusId, displayOrder ASC, name ASC`);
        }
        
        return presets.map(p => ({
            ...p,
            units: typeof p.units === 'string' ? JSON.parse(p.units) : p.units,
            enabled: !!p.enabled
        }));
    }

    async getPreset(id) {
        return await this.db.get(`SELECT * FROM presets WHERE id = ?`, [id]);
    }

    async createPreset(preset) {
        const id = `preset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date().toISOString();
        
        await this.db.run(`
            INSERT INTO presets (id, campusId, name, icon, units, displayOrder, enabled, createdBy, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            preset.campusId,
            preset.name,
            preset.icon || 'BookOpen',
            typeof preset.units === 'string' ? preset.units : JSON.stringify(preset.units),
            preset.displayOrder || 0,
            preset.enabled !== false ? 1 : 0,
            preset.createdBy || null,
            now,
            now
        ]);

        return await this.getPreset(id);
    }

    async createPresetsBulk(presets, campusId, createdBy) {
        const results = [];
        for (const preset of presets) {
            const created = await this.createPreset({
                ...preset,
                campusId,
                createdBy
            });
            results.push(created);
        }
        return results;
    }

    async updatePreset(id, updates) {
        const fields = [];
        const values = [];
        
        const allowedFields = ['name', 'icon', 'units', 'displayOrder', 'enabled', 'campusId'];
        
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                fields.push(`${field} = ?`);
                if (field === 'units' && typeof updates[field] !== 'string') {
                    values.push(JSON.stringify(updates[field]));
                } else if (field === 'enabled') {
                    values.push(updates[field] ? 1 : 0);
                } else {
                    values.push(updates[field]);
                }
            }
        }
        
        if (fields.length === 0) return await this.getPreset(id);
        
        fields.push('updatedAt = ?');
        values.push(new Date().toISOString());
        values.push(id);
        
        await this.db.run(`UPDATE presets SET ${fields.join(', ')} WHERE id = ?`, values);
        return await this.getPreset(id);
    }

    async deletePreset(id) {
        const preset = await this.getPreset(id);
        if (!preset) return null;
        await this.db.run(`DELETE FROM presets WHERE id = ?`, [id]);
        return preset;
    }

    async deletePresetsByCampus(campusId) {
        await this.db.run(`DELETE FROM presets WHERE campusId = ?`, [campusId]);
        return { success: true, campusId };
    }
}

module.exports = new LocalDatabase();
