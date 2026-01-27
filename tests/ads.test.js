/**
 * Ads API Tests
 * Tests for the Ads/Billboard system endpoints
 */

const request = require('supertest');

// We'll start a separate test server
const BACKEND_URL = 'http://localhost:5001';

describe('Ads API', () => {
  let createdAdId;

  // =======================
  // AD SETTINGS TESTS
  // =======================
  
  describe('GET /api/ads/settings', () => {
    it('should return ad settings', async () => {
      const res = await request(BACKEND_URL)
        .get('/api/ads/settings')
        .expect(200);
      
      expect(res.body).toHaveProperty('adsEnabled');
      expect(res.body).toHaveProperty('emojiRainDuration');
      expect(res.body).toHaveProperty('adCycleDuration');
      expect(res.body).toHaveProperty('rotationMode');
    });
  });

  // =======================
  // ADS LIST TESTS
  // =======================
  
  describe('GET /api/ads', () => {
    it('should return a list of ads', async () => {
      const res = await request(BACKEND_URL)
        .get('/api/ads')
        .expect(200);
      
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should filter by status', async () => {
      const res = await request(BACKEND_URL)
        .get('/api/ads?status=live')
        .expect(200);
      
      expect(Array.isArray(res.body)).toBe(true);
      res.body.forEach(ad => {
        expect(ad.status).toBe('live');
      });
    });

    it('should filter active ads', async () => {
      const res = await request(BACKEND_URL)
        .get('/api/ads?activeNow=true')
        .expect(200);
      
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // =======================
  // Note: Create/Update/Delete require admin auth
  // These tests verify endpoint existence
  // =======================

  describe('POST /api/ads (requires auth)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(BACKEND_URL)
        .post('/api/ads')
        .send({
          title: 'Test Ad',
          type: 'image',
          mediaUrl: 'https://example.com/test.jpg'
        })
        .expect(401);
    });
  });

  describe('PUT /api/ads/settings (requires auth)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(BACKEND_URL)
        .put('/api/ads/settings')
        .send({ adsEnabled: true })
        .expect(401);
    });
  });

  // =======================
  // TRACKING TESTS (Public)
  // =======================

  describe('POST /api/ads/:id/click', () => {
    it('should track click for valid ad ID', async () => {
      // Use a fake ID - endpoint should still work
      const res = await request(BACKEND_URL)
        .post('/api/ads/test_ad_123/click')
        .expect(200);
      
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/ads/:id/impression', () => {
    it('should track impression for valid ad ID', async () => {
      const res = await request(BACKEND_URL)
        .post('/api/ads/test_ad_123/impression')
        .expect(200);
      
      expect(res.body.success).toBe(true);
    });
  });

  // =======================
  // BULK OPERATIONS (require auth)
  // =======================

  describe('POST /api/ads/pause-all (requires auth)', () => {
    it('should return 401 without auth', async () => {
      await request(BACKEND_URL)
        .post('/api/ads/pause-all')
        .expect(401);
    });
  });

  describe('POST /api/ads/resume-all (requires auth)', () => {
    it('should return 401 without auth', async () => {
      await request(BACKEND_URL)
        .post('/api/ads/resume-all')
        .expect(401);
    });
  });

  // =======================
  // UPLOAD (requires auth)
  // =======================

  describe('POST /api/ads/upload (requires auth)', () => {
    it('should return 401 without auth', async () => {
      await request(BACKEND_URL)
        .post('/api/ads/upload')
        .expect(401);
    });
  });
});

// =======================
// DATABASE CRUD TESTS (Unit tests)
// =======================

describe('LocalDB Ads Methods', () => {
  // These would require importing the database directly
  // For now, we verify API contract

  it('should have correct response structure for settings', async () => {
    const res = await request(BACKEND_URL)
      .get('/api/ads/settings')
      .expect(200);
    
    const expectedFields = ['adsEnabled', 'emojiRainDuration', 'adCycleDuration', 'rotationMode'];
    expectedFields.forEach(field => {
      expect(res.body).toHaveProperty(field);
    });
  });

  it('returned ads should have correct structure', async () => {
    const res = await request(BACKEND_URL)
      .get('/api/ads')
      .expect(200);
    
    if (res.body.length > 0) {
      const ad = res.body[0];
      expect(ad).toHaveProperty('id');
      expect(ad).toHaveProperty('title');
      expect(ad).toHaveProperty('type');
      expect(ad).toHaveProperty('status');
      expect(ad).toHaveProperty('enabled');
    }
  });
});
