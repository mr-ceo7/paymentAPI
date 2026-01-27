/**
 * Seed Universities Script
 * Migrates static university configurations to the database.
 * Run with: node seed-universities.js
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// Universities to seed (from types/university.ts)
const UNIVERSITIES_TO_SEED = [
    {
        id: 'uni_uon',
        name: 'University of Nairobi',
        shortCode: 'UON',
        slug: 'uon',
        structureType: 'campus',
        colors: {
            primary: 'from-blue-600 to-purple-600',
            secondary: 'bg-blue-600',
            accent: 'text-blue-500'
        },
        tagline: 'World Class Scholarly Excellence',
        faviconUrl: 'https://ui-avatars.com/api/?name=UoN&background=2563eb&color=fff&rounded=true',
        defaultCampus: 'chiromo'
    },
    {
        id: 'uni_ku',
        name: 'Kenyatta University',
        shortCode: 'KU',
        slug: 'ku',
        structureType: 'campus',
        colors: {
            primary: 'from-green-700 to-olive-600',
            secondary: 'bg-green-700',
            accent: 'text-green-600'
        },
        tagline: 'Transforming Higher Education',
        faviconUrl: 'https://i.pinimg.com/736x/c3/f3/84/c3f384f9510c99b12282935131b1d9fb.jpg',
        ogImageUrl: 'https://nnmedia.nation.africa/uploads/2019/03/3a253cc3-f6f4-4b03-96a0-6041896ff7e8-1320x740.jpg',
        defaultCampus: 'ku_main'
    },
    {
        id: 'uni_jkuat',
        name: 'Jomo Kenyatta University of Agriculture and Technology',
        shortCode: 'JKUAT',
        slug: 'jkuat',
        structureType: 'campus',
        colors: {
            primary: 'from-green-600 to-teal-600',
            secondary: 'bg-green-600',
            accent: 'text-teal-500'
        },
        tagline: 'Setting Trends in Higher Education',
        faviconUrl: 'https://www.jkuat.ac.ke/wp-content/uploads/2024/04/jkuatlogo1.png',
        ogImageUrl: 'https://www.jkuat.ac.ke/directorate/aca/wp-content/uploads/2023/04/aStudents-access-online-learning-material-at-the-Graduation-Pavillion-at-the-main-campus-Juja.-scaled-1.jpg',
        defaultCampus: 'jkuat_main'
    },
    {
        id: 'uni_mmu',
        name: 'Maasai Mara University',
        shortCode: 'MMU',
        slug: 'mmu',
        structureType: 'campus',
        colors: {
            primary: 'from-orange-600 to-red-600',
            secondary: 'bg-orange-600',
            accent: 'text-orange-500'
        },
        tagline: 'Engravers of the Future',
        faviconUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSrrvRwAtrlcVRcka9qqagLnJn-XrKpbgVd0A&s',
        ogImageUrl: 'https://www.mmarau.ac.ke/wp-content/uploads/2021/08/Gate.jpg',
        defaultCampus: 'mmu_main'
    },
    {
        id: 'uni_dkut',
        name: 'Dedan Kimathi University of Technology',
        shortCode: 'DKUT',
        slug: 'dkut',
        structureType: 'campus',
        colors: {
            primary: 'from-green-700 to-emerald-900',
            secondary: 'bg-green-700',
            accent: 'text-green-600'
        },
        tagline: 'Better Life through Technology',
        faviconUrl: 'https://www.dkut.ac.ke/images/logo-header.png',
        ogImageUrl: 'https://kenyanlife.com/wp-content/uploads/2016/09/DKUT-Dedan-Kimathi-University-Student-1.jpg',
        defaultCampus: 'dkut_engineering'
    }
];

async function checkExistingUniversities() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/universities`);
        const unis = await res.json();
        return unis.map(u => u.id);
    } catch (e) {
        console.error('Failed to fetch existing universities:', e.message);
        return [];
    }
}

async function seedUniversity(uni) {
    try {
        // Use direct database insert via admin endpoint
        // Note: This bypasses auth for seeding purposes - run locally only
        const res = await fetch(`${BACKEND_URL}/api/seed/university`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uni)
        });
        
        if (!res.ok) {
            const error = await res.text();
            throw new Error(`API Error: ${res.status} - ${error}`);
        }
        
        const result = await res.json();
        console.log(`✅ Seeded: ${uni.name} (${uni.slug})`);
        return result;
    } catch (e) {
        console.error(`❌ Failed to seed ${uni.name}:`, e.message);
        return null;
    }
}

async function seedCampuses() {
    // Define campuses for each university
    const campuses = [
        // UoN Campuses
        { universityId: 'uni_uon', name: 'Chiromo Campus', slug: 'chiromo' },
        { universityId: 'uni_uon', name: 'Main Campus', slug: 'main' },
        { universityId: 'uni_uon', name: 'Parklands Campus', slug: 'parklands' },
        { universityId: 'uni_uon', name: 'Kenya Science Campus', slug: 'kenya_science' },
        { universityId: 'uni_uon', name: 'Upper Kabete Campus', slug: 'upper_kabete' },
        { universityId: 'uni_uon', name: 'Lower Kabete Campus', slug: 'lower_kabete' },
        { universityId: 'uni_uon', name: 'KNH Campus', slug: 'knh' },
        { universityId: 'uni_uon', name: 'Kikuyu Campus', slug: 'kikuyu' },
        
        // KU Campuses
        { universityId: 'uni_ku', name: 'Main Campus', slug: 'ku_main' },
        { universityId: 'uni_ku', name: 'Ruiru Campus', slug: 'ku_ruiru' },
        { universityId: 'uni_ku', name: 'Parklands Campus', slug: 'ku_parklands' },
        
        // JKUAT Campuses
        { universityId: 'uni_jkuat', name: 'Main Campus', slug: 'jkuat_main' },
        { universityId: 'uni_jkuat', name: 'Karen Campus', slug: 'jkuat_karen' },
        
        // MMU Campus
        { universityId: 'uni_mmu', name: 'Main Campus', slug: 'mmu_main' },
        
        // DKUT Schools (using as campuses for structure type)
        { universityId: 'uni_dkut', name: 'School of Engineering', slug: 'dkut_engineering' },
        { universityId: 'uni_dkut', name: 'School of Science', slug: 'dkut_science' },
        { universityId: 'uni_dkut', name: 'School of CS & IT', slug: 'dkut_cs_it' },
        { universityId: 'uni_dkut', name: 'Business Mgt & Economics', slug: 'dkut_business' },
        { universityId: 'uni_dkut', name: 'School of Nursing', slug: 'dkut_nursing' },
        { universityId: 'uni_dkut', name: 'Institutes', slug: 'dkut_institutes' }
    ];
    
    for (const campus of campuses) {
        try {
            const res = await fetch(`${BACKEND_URL}/api/seed/campus`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(campus)
            });
            
            if (res.ok) {
                console.log(`  📍 Campus: ${campus.name}`);
            }
        } catch (e) {
            console.error(`  ❌ Failed campus ${campus.slug}:`, e.message);
        }
    }
}

async function main() {
    console.log('🚀 University Seed Script');
    console.log(`   Backend: ${BACKEND_URL}\n`);
    
    // Check existing
    const existing = await checkExistingUniversities();
    console.log(`📊 Existing universities in DB: ${existing.length}`);
    console.log(`   IDs: ${existing.join(', ') || 'none'}\n`);
    
    // Seed missing universities
    for (const uni of UNIVERSITIES_TO_SEED) {
        if (existing.includes(uni.id)) {
            console.log(`⏭️  Skipping ${uni.name} (already exists)`);
            continue;
        }
        
        await seedUniversity(uni);
    }
    
    console.log('\n📍 Seeding campuses...');
    await seedCampuses();
    
    console.log('\n✅ Seed complete!');
}

main().catch(console.error);
