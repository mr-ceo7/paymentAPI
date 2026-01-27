const LocalDatabase = require('../database');
const fs = require('fs');
const path = require('path');

// Mock payload simulating what the frontend would send
const MOCK_PAYLOAD = {
    campusId: 'test_campus_123',
    units: [
        {
            code: 'TEST 101',
            title: 'Intro to Database Verification',
            date: '2026-02-14',
            time: '09:00 AM',
            venue: 'LAB 1',
            level: 1
        },
        {
            code: 'TEST 102',
            title: 'Advanced AI Parsers',
            date: '2026-02-15',
            time: '02:00 PM',
            venue: 'HALL A',
            level: 2
        }
    ]
};

async function runTest() {
    console.log('🧪 Starting Database Save Verification...');
    
    // Initialize DB
    await LocalDatabase.init();
    
    // 1. Check count before
    const beforeStats = await LocalDatabase.db.get('SELECT COUNT(*) as count FROM timetables WHERE campusId = ?', MOCK_PAYLOAD.campusId);
    console.log(`Checking existing records for campus ${MOCK_PAYLOAD.campusId}: ${beforeStats.count}`);
    
    // 2. Run Save
    console.log(`Saving ${MOCK_PAYLOAD.units.length} units...`);
    const result = await LocalDatabase.saveTimetable(MOCK_PAYLOAD.campusId, MOCK_PAYLOAD.units);
    console.log(`Save Result:`, result);
    
    if (result.count !== MOCK_PAYLOAD.units.length) {
        throw new Error(`Expected to insert ${MOCK_PAYLOAD.units.length} rows, but got ${result.count}`);
    }
    
    // 3. Verify Insertion
    const afterStats = await LocalDatabase.db.get('SELECT COUNT(*) as count FROM timetables WHERE campusId = ?', MOCK_PAYLOAD.campusId);
    console.log(`New record count: ${afterStats.count}`);
    
    if (afterStats.count !== beforeStats.count + MOCK_PAYLOAD.units.length) {
         throw new Error('Database count did not increase by expected amount!');
    }
    
    // 4. Verify Content
    const rows = await LocalDatabase.db.all('SELECT * FROM timetables WHERE campusId = ? ORDER BY createdAt DESC LIMIT 2', MOCK_PAYLOAD.campusId);
    console.log('Verifying inserted rows:', rows);
    
    const insertedUnit = rows.find(r => r.code === 'TEST 101');
    if (!insertedUnit || insertedUnit.title !== 'Intro to Database Verification') {
        throw new Error('Inserted data mismatch for TEST 101');
    }
    
    console.log('✅ DATABASE SAVE TEST PASSED!');
    
    // Cleanup (Optional, but good for test hygiene)
    await LocalDatabase.db.run('DELETE FROM timetables WHERE campusId = ?', MOCK_PAYLOAD.campusId);
    console.log('🧹 Cleanup: Deleted test records.');
}

runTest().catch(e => {
    console.error('❌ Test Failed:', e);
    process.exit(1);
});
