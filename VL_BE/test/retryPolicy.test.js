// Chức năng: kiểm thử luật thử lại - chỉ lỗi tạm thời mới được thử lại, có giới hạn số lần, backoff tăng dần có trần.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIError } from '../ai/provider.js';
import { BACKOFF_MAX_MS, backoffMs, isTransient, shouldRetry } from '../worker/retryPolicy.js';
import { UserError } from '../worker/extract.js';

test('lỗi AI tạm thời (429/5xx/mạng) được thử lại', () => {
    assert.equal(isTransient(new AIError('AI lỗi 429', { retryable: true, code: 'ai-rate-limit' })), true);
    assert.equal(isTransient(new AIError('Không gọi được AI', { retryable: true, code: 'ai-network' })), true);
});

test('lỗi AI không tạm thời (thiếu key, bị chặn, bị cắt) KHÔNG được thử lại', () => {
    assert.equal(isTransient(new AIError('Thiếu key', { code: 'ai-no-key' })), false);
    assert.equal(isTransient(new AIError('AI từ chối nội dung', { code: 'ai-blocked' })), false);
    assert.equal(isTransient(new AIError('bị cắt', { code: 'ai-truncated' })), false);
});

test('lỗi do người dùng (UserError) KHÔNG được thử lại', () => {
    assert.equal(isTransient(new UserError('File hỏng', 'pdf-unreadable')), false);
});

test('lỗi Firestore/mạng tạm thời được thử lại; lỗi lập trình (không có mã) thì không', () => {
    assert.equal(isTransient({ code: 14, message: 'UNAVAILABLE' }), true);
    assert.equal(isTransient({ code: 4, message: 'DEADLINE_EXCEEDED' }), true);
    assert.equal(isTransient({ code: 'ECONNRESET', message: 'socket hang up' }), true);
    assert.equal(isTransient(new TypeError('x is undefined')), false);
    assert.equal(isTransient(new Error('AI không hợp lệ')), false);
});

test('shouldRetry: còn lượt mới thử lại, hết lượt thì dừng', () => {
    const transient = new AIError('AI lỗi 503', { retryable: true, code: 'ai-http' });
    assert.equal(shouldRetry(transient, 1, 3), true);
    assert.equal(shouldRetry(transient, 2, 3), true);
    assert.equal(shouldRetry(transient, 3, 3), false);
});

test('shouldRetry: lỗi không tạm thời không bao giờ được thử lại dù còn lượt', () => {
    assert.equal(shouldRetry(new TypeError('bug'), 1, 3), false);
    assert.equal(shouldRetry(new UserError('file hỏng'), 1, 3), false);
});

test('backoff tăng gấp đôi và có trần', () => {
    assert.equal(backoffMs(1), 30_000);
    assert.equal(backoffMs(2), 60_000);
    assert.equal(backoffMs(3), 120_000);
    assert.equal(backoffMs(50), BACKOFF_MAX_MS);
});
