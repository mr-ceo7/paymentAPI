const LocalDatabase = require('../database');
const fs = require('fs');

const TEST_PRESET = {
    id: 'test_preset_001',
    campusId: 'test_campus_123',
    name: 'TEST PRESET CS Y1',
    units: ['CSC 101', 'MAT 101'],
    icon: 'Terminal',
    displayOrder: 1
};

async function runTest() {
    console.log('🧪 Starting Presets Verification...');
    
    await LocalDatabase.init();
    
    // 1. Save
    console.log(`Saving preset: ${TEST_PRESET.name}`);
    await LocalDatabase.savePreset(TEST_PRESET);
    
    // 2. Fetch
    console.log(`Fetching presets for campus ${TEST_PRESET.campusId}...`);
    const presets = await LocalDatabase.getPresets(TEST_PRESET.campusId);
    console.log('Presets found:', presets);
    
    const saved = presets.find(p => p.id === TEST_PRESET.id);
    if (!saved) throw new Error('Preset not found after save!');
    if (!saved.units.includes('CSC 101')) throw new Error('Preset units mismatch!');
    
    // 3. Delete
    console.log(`Deleting preset ${TEST_PRESET.id}...`);
    await LocalDatabase.deletePreset(TEST_PRESET.id);
    
    const afterDelete = await LocalDatabase.getPresets(TEST_PRESET.campusId);
    if (afterDelete.find(p => p.id === TEST_PRESET.id)) {
        throw new Error('Preset still exists after delete!');
    }
    
    console.log('✅ PRESET VERIFICATION PASSED!');
}

runTest().catch(e => {
    console.error('❌ Test Failed:', e);
    process.exit(1);
});
