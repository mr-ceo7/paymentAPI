const LocalDatabase = require('../database');

async function checkTukData() {
    await LocalDatabase.init();
    
    console.log("--- MECH_ENG SAMPLE ---");
    const samples = await LocalDatabase.db.all("SELECT code, title, date, time, venue FROM timetables WHERE campusId = ? LIMIT 5", ['mech_Eng']);
    console.log(JSON.stringify(samples, null, 2));
}

checkTukData().catch(console.error);


