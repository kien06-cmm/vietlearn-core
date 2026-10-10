// Chức năng: kiểm thử xử lý 429 / hết quota - đọc Retry-After và RetryInfo, phân biệt quota theo phút với quota theo ngày,
// tạm nghỉ toàn cục (cooldown), thời gian chờ thử lại và luật chọn job khi đang tạm nghỉ. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_COOLDOWN_MS, MAX_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS, cooldownMsFor, createCooldown } from '../ai/cooldown.js';
import { AIError } from '../ai/errors.js';
import { httpErrorFor, parseQuotaError, parseRetryAfterHeader } from '../ai/quotaError.js';
import { AI_JOB_TYPES, selectReady } from '../worker/queueRules.js';
import { BACKOFF_BASE_MS, RETRY_AFTER_MAX_MS, backoffMs, isTransient, retryDelayMs, shouldRetry } from '../worker/retryPolicy.js';

// Thân lỗi 429 mẫu theo định dạng của Google
const body = (details) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details } });
const RETRY_INFO = (delay) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const QUOTA_FAILURE = (quotaId) => ({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] });

// ---------- Retry-After ----------

test('Retry-After dạng số giây', () => {
    assert.equal(parseRetryAfterHeader('30'), 30_000);
    assert.equal(parseRetryAfterHeader('1.5'), 1500);
});

test('Retry-After dạng ngày giờ HTTP', () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    assert.equal(parseRetryAfterHeader('Sat, 10 Oct 2026 10:01:00 GMT', now), 60_000);
    assert.equal(parseRetryAfterHeader('Sat, 10 Oct 2026 09:00:00 GMT', now), 0, 'thời điểm đã qua thì không chờ');
});

test('Retry-After thiếu hoặc không hiểu thì trả null', () => {
    assert.equal(parseRetryAfterHeader(null), null);
    assert.equal(parseRetryAfterHeader(''), null);
    assert.equal(parseRetryAfterHeader('abc'), null);
});

// ---------- Phân loại 429 ----------

test('429 có RetryInfo: lấy thời gian chờ từ thân lỗi', () => {
    const q = parseQuotaError({ bodyText: body([RETRY_INFO('34s')]) });
    assert.equal(q.retryAfterMs, 34_000);
    assert.equal(q.daily, false);
});

test('header Retry-After được ưu tiên hơn RetryInfo', () => {
    const q = parseQuotaError({ retryAfterHeader: '10', bodyText: body([RETRY_INFO('34s')]) });
    assert.equal(q.retryAfterMs, 10_000);
});

test('quota theo phút không bị coi là hết quota ngày', () => {
    const q = parseQuotaError({ bodyText: body([QUOTA_FAILURE('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')]) });
    assert.equal(q.daily, false);
});

test('quota theo ngày được nhận ra', () => {
    const q = parseQuotaError({ bodyText: body([QUOTA_FAILURE('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]) });
    assert.equal(q.daily, true);
});

test('thân lỗi không phải JSON: không báo lỗi, chỉ dùng header', () => {
    const q = parseQuotaError({ retryAfterHeader: '5', bodyText: '<html>Too Many Requests</html>' });
    assert.deepEqual(q, { retryAfterMs: 5000, daily: false });
});

test('httpErrorFor 429 theo phút: thử lại được, mang theo thời gian chờ', () => {
    const err = httpErrorFor(429, '20', body([]));
    assert.ok(err instanceof AIError);
    assert.equal(err.code, 'ai-rate-limit');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 20_000);
});

test('httpErrorFor 429 theo ngày: KHÔNG thử lại, có thời gian nghỉ mặc định', () => {
    const err = httpErrorFor(429, null, body([QUOTA_FAILURE('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]));
    assert.equal(err.code, 'ai-quota-daily');
    assert.equal(err.retryable, false);
    assert.equal(err.retryAfterMs, DAILY_COOLDOWN_MS);
});

test('httpErrorFor: 5xx thử lại được, 4xx khác thì không', () => {
    assert.equal(httpErrorFor(503, '7', '').retryable, true);
    assert.equal(httpErrorFor(503, '7', '').retryAfterMs, 7000);
    assert.equal(httpErrorFor(400, null, 'bad request').retryable, false);
    assert.equal(httpErrorFor(403, null, 'forbidden').retryable, false);
});

// ---------- Tạm nghỉ toàn cục ----------

test('cooldown: đang nghỉ thì còn thời gian, hết giờ thì về 0', () => {
    let t = 1_000_000;
    const cd = createCooldown(() => t);
    assert.equal(cd.remainingMs(), 0);
    cd.start(30_000);
    assert.equal(cd.remainingMs(), 30_000);
    t += 10_000;
    assert.equal(cd.remainingMs(), 20_000);
    t += 20_000;
    assert.equal(cd.remainingMs(), 0);
});

test('cooldown: không bao giờ bị rút ngắn, chỉ được kéo dài', () => {
    let t = 0;
    const cd = createCooldown(() => t);
    cd.start(60_000);
    cd.start(5_000);
    assert.equal(cd.remainingMs(), 60_000);
    cd.start(120_000);
    assert.equal(cd.remainingMs(), 120_000);
});

test('cooldown: có trần 30 phút', () => {
    const cd = createCooldown(() => 0);
    cd.start(24 * 3_600_000);
    assert.equal(cd.remainingMs(), MAX_COOLDOWN_MS);
});

test('cooldown: reset đưa về 0', () => {
    const cd = createCooldown(() => 0);
    cd.start(60_000);
    cd.reset();
    assert.equal(cd.remainingMs(), 0);
});

test('cooldownMsFor: chỉ 429 và hết quota ngày mới làm hệ thống tạm nghỉ', () => {
    assert.equal(cooldownMsFor(new AIError('x', { code: 'ai-rate-limit' })), RATE_LIMIT_COOLDOWN_MS);
    assert.equal(cooldownMsFor(new AIError('x', { code: 'ai-rate-limit', retryAfterMs: 5000 })), 5000);
    assert.equal(cooldownMsFor(new AIError('x', { code: 'ai-quota-daily' })), DAILY_COOLDOWN_MS);
    assert.equal(cooldownMsFor(new AIError('x', { code: 'ai-network', retryable: true })), null);
    assert.equal(cooldownMsFor(new AIError('x', { code: 'ai-http', retryable: true })), null);
    assert.equal(cooldownMsFor(new Error('lỗi khác')), null);
});

// ---------- Thời gian chờ thử lại ----------

test('retryDelayMs: không có gợi ý thì dùng backoff', () => {
    assert.equal(retryDelayMs(1, new AIError('x', { retryable: true })), BACKOFF_BASE_MS);
    assert.equal(retryDelayMs(2, new AIError('x', { retryable: true })), backoffMs(2));
});

test('retryDelayMs: Gemini yêu cầu chờ lâu hơn backoff thì chờ theo Gemini', () => {
    const err = new AIError('x', { retryable: true, retryAfterMs: 5 * 60_000 });
    assert.equal(retryDelayMs(1, err), 5 * 60_000);
});

test('retryDelayMs: gợi ý ngắn hơn backoff thì vẫn dùng backoff; gợi ý quá lớn bị chặn ở 30 phút', () => {
    assert.equal(retryDelayMs(2, new AIError('x', { retryable: true, retryAfterMs: 1000 })), backoffMs(2));
    assert.equal(retryDelayMs(1, new AIError('x', { retryable: true, retryAfterMs: 99 * 3_600_000 })), RETRY_AFTER_MAX_MS);
});

test('hết quota ngày không được thử lại; 429 theo phút thì được, có giới hạn lần', () => {
    const daily = httpErrorFor(429, null, body([QUOTA_FAILURE('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]));
    const perMinute = httpErrorFor(429, null, body([]));
    assert.equal(isTransient(daily), false);
    assert.equal(shouldRetry(daily, 1, 3), false);
    assert.equal(shouldRetry(perMinute, 1, 3), true);
    assert.equal(shouldRetry(perMinute, 3, 3), false);
});

// ---------- Chọn job khi đang tạm nghỉ ----------

const jobDoc = (id, type, runAfterMs) => ({ id, data: () => ({ type, ...(runAfterMs === undefined ? {} : { runAfter: { toMillis: () => runAfterMs } }) }) });

test('selectReady: bỏ job chưa đến giờ, sắp theo runAfter', () => {
    const docs = [jobDoc('late', 'extract_document', 5000), jobDoc('b', 'extract_document', 200), jobDoc('a', 'extract_document', 100)];
    assert.deepEqual(selectReady(docs, 1000).map((d) => d.id), ['a', 'b']);
});

test('selectReady: đang tạm nghỉ thì bỏ các job dùng AI, giữ job trích văn bản', () => {
    const docs = [jobDoc('q', 'generate_questions', 1), jobDoc('p', 'generate_practice', 2), jobDoc('x', 'extract_document', 3)];
    assert.deepEqual(selectReady(docs, 1000, AI_JOB_TYPES).map((d) => d.id), ['x']);
    assert.deepEqual(selectReady(docs, 1000).map((d) => d.id), ['q', 'p', 'x']);
});

test('selectReady: job thiếu runAfter coi như chạy được ngay và không làm lỗi khi sắp xếp', () => {
    const docs = [jobDoc('new', 'extract_document'), jobDoc('old', 'extract_document', 500)];
    assert.deepEqual(selectReady(docs, 1000).map((d) => d.id), ['new', 'old']);
});
