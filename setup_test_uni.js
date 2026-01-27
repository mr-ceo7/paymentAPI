const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

async function createTestUni() {
    console.log('🚀 Creating test university in database...\n');

    try {
        // Connect to database
        const db = await open({
            filename: path.join(__dirname, 'data', 'database.sqlite'),
            driver: sqlite3.Database
        });

        console.log('📂 Connected to database at:', path.join(__dirname, 'data', 'database.sqlite'));

        // Insert test university
        console.log('\n📝 Inserting: Maseno University');
        await db.run(`
            INSERT OR IGNORE INTO universities (id, name, shortCode, createdAt)
            VALUES (?, ?, ?, datetime('now'))
        `, ['uni_maseno', 'Maseno University', 'MU']);

        // Verify insertion
        const maseno = await db.get('SELECT * FROM universities WHERE id = ?', 'uni_maseno');
        console.log('✅ Maseno University created:', maseno);

        // List all universities
        console.log('\n📋 All universities in database:');
        const all = await db.all('SELECT * FROM universities ORDER BY name');
        all.forEach(u => {
            console.log(`   - ${u.name} (${u.shortCode}) [${u.id}]`);
        });

        await db.close();

        console.log('\n✅ Database setup complete!');
        console.log('\n🔗 Test the dynamic loading:');
        console.log('   1. Frontend running at: http://localhost:3001');
        console.log('   2. Visit: http://localhost:3001/maseno');
        console.log('   3. Check browser console for useUniversitiesList hook logs');
        console.log('   4. The university should load if dynamic loading works!');

    } catch (e) {
        console.error('❌ Error:', e.message);
        if (e.code === 'SQLITE_CANTOPEN') {
            console.log('\n💡 Database file not found. Make sure the backend has run once to initialize it.');
            console.log('   Run: npm start (from payment_backend directory)');
        }
    }
}

createTestUni();
