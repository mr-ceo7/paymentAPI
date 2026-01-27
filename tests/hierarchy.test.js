
const LocalDB = require('../database');
const path = require('path');
const fs = require('fs');

// Ensure we use test database
process.env.NODE_ENV = 'test';

describe('Hierarchical Structure Management', () => {
    
    beforeAll(async () => {
        // Initialize DB (connects to database.test.sqlite)
        await LocalDB.init();
        
        // Clear tables for fresh start
        await LocalDB.db.exec('DELETE FROM data_versions');
        await LocalDB.db.exec('DELETE FROM options');
        await LocalDB.db.exec('DELETE FROM departments');
        await LocalDB.db.exec('DELETE FROM faculties');
        await LocalDB.db.exec('DELETE FROM campuses');
        await LocalDB.db.exec('DELETE FROM universities');
    });

    afterAll(async () => {
        // Cleanup if needed, or leave for inspection
        // await LocalDB.db.close(); 
    });

    const uniData = { name: 'Test University', shortCode: 'TEST_UNI', structureType: 'campus' };
    const campusData = { name: 'Test Campus', slug: 'test-campus' };
    const facultyData = { name: 'Faculty of Science', slug: 'science' };
    const deptData = { name: 'Department of CS', slug: 'cs' };
    const optionData = { name: 'Software Engineering', slug: 'se' };

    let uniId, campusId, facultyId, deptId, optionId;

    test('Should create a University', async () => {
        uniId = uniData.shortCode;
        const uni = await LocalDB.createUniversity({ 
            id: uniId,
            name: uniData.name, 
            shortCode: uniData.shortCode, 
            structureType: uniData.structureType 
        });
        expect(uni).toHaveProperty('id');
        expect(uni.name).toBe(uniData.name);
    });

    test('Should create a Campus', async () => {
        campusId = campusData.slug;
        const campus = await LocalDB.createCampus({
            id: campusId,
            universityId: uniId,
            name: campusData.name,
            slug: campusData.slug
        });
        expect(campus).toHaveProperty('id');
        expect(campus.universityId).toBe(uniId);
    });

    test('Should create a Faculty under Campus', async () => {
        const faculty = await LocalDB.createFaculty({
            id: `fac_${Date.now()}`,
            campusId: campusId,
            name: facultyData.name,
            slug: facultyData.slug
        });
        expect(faculty).toHaveProperty('id');
        expect(faculty.campusId).toBe(campusId);
        facultyId = faculty.id;
    });

    test('Should create a Department under Faculty', async () => {
        const dept = await LocalDB.createDepartment({
            id: `dept_${Date.now()}`,
            facultyId: facultyId,
            name: deptData.name,
            slug: deptData.slug
        });
        expect(dept).toHaveProperty('id');
        expect(dept.facultyId).toBe(facultyId);
        deptId = dept.id;
    });

    test('Should create an Option under Department', async () => {
        const option = await LocalDB.createOption({
            id: `opt_${Date.now()}`,
            departmentId: deptId,
            name: optionData.name,
            slug: optionData.slug
        });
        expect(option).toHaveProperty('id');
        expect(option.departmentId).toBe(deptId);
        optionId = option.id;
    });

    test('Should retrieve Hierarchy correctly', async () => {
        // Check Faculty
        const faculties = await LocalDB.getFaculties(campusId);
        expect(faculties.length).toBeGreaterThan(0);
        expect(faculties.find(f => f.id === facultyId)).toBeTruthy();

        // Check Dept
        const depts = await LocalDB.getDepartments(facultyId);
        expect(depts.length).toBeGreaterThan(0);
        expect(depts.find(d => d.id === deptId)).toBeTruthy();

        // Check Option
        const options = await LocalDB.getOptions(deptId);
        expect(options.length).toBeGreaterThan(0);
        expect(options.find(o => o.id === optionId)).toBeTruthy();
    });

    test('Cascade Delete: Deleting Faculty should delete Departments', async () => {
        // Delete Faculty
        await LocalDB.deleteFaculty(facultyId);

        // Check Dept
        const depts = await LocalDB.getDepartments(facultyId); // Should be empty
        expect(depts.length).toBe(0);

        // Check Option (orphaned by cascade from Dept)
        // Since we can't query options by parent ID if parent is gone easily, unless we check getAllOptions or verify by ID
        // But getOptions needs deptId. 
        // We can check all options table directly
        const allOptions = await LocalDB.getAllOptions();
        const deletedOption = allOptions.find(o => o.id === optionId);
        expect(deletedOption).toBeUndefined();
    });

});
