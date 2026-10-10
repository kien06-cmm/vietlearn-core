// Chức năng: kiểm thử luật Admin - chuẩn hóa email tìm kiếm, gói hợp lệ, dữ liệu người dùng trả cho Admin. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_NAMES, isValidPlan, normalizeEmail, toAdminUser } from '../adminRules.js';

test('email: bỏ khoảng trắng, viết thường; không giống email thì rỗng', () => {
    assert.equal(normalizeEmail('  Kien@Gmail.COM '), 'kien@gmail.com');
    assert.equal(normalizeEmail('khong-phai-email'), '');
    assert.equal(normalizeEmail('a b@c.com'), '');
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail(undefined), '');
    assert.equal(normalizeEmail(`${'a'.repeat(250)}@x.com`), '');
});

test('gói hợp lệ: chỉ các gói có trong config/plans.js', () => {
    assert.deepEqual([...PLAN_NAMES].sort(), ['free', 'pro']);
    assert.equal(isValidPlan('pro'), true);
    assert.equal(isValidPlan('free'), true);
    assert.equal(isValidPlan('enterprise'), false);
    assert.equal(isValidPlan(undefined), false);
});

test('dữ liệu Admin xem: gói lạ coi như free, timestamp thành ISO, cờ admin và xóa', () => {
    const at = new Date('2026-10-10T08:00:00Z');
    const u = toAdminUser('u1', { email: 'a@b.com', displayName: 'A', plan: 'weird', isAdmin: true, deletedAt: at, createdAt: { toMillis: () => at.getTime() } });
    assert.deepEqual(u, { uid: 'u1', email: 'a@b.com', displayName: 'A', plan: 'free', isAdmin: true, deleted: true, createdAt: '2026-10-10T08:00:00.000Z' });
    const v = toAdminUser('u2', {});
    assert.equal(v.deleted, false);
    assert.equal(v.isAdmin, false);
    assert.equal(v.createdAt, null);
    assert.equal(v.email, null);
});
