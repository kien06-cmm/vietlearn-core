// Chức năng: kiểm thử generateJson với Gemini giả (thay fetch) - 429, hết quota ngày, timeout, lỗi 5xx, tạm nghỉ toàn cục
// và việc luôn trả lại lượt chạy đồng thời. Không gọi mạng thật. Chạy: npm test
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_API_KEY = 'khoa-gia-cho-test';
process.env.AI_MAX_CONCURRENT = '1'; // chỉ 1 lượt để test được việc chờ trong hàng đợi (phải đặt TRƯỚC khi nạp provider)
delete process.env.AI_PROVIDER; // dùng nhà cung cấp Gemini thật, nhưng fetch bị thay bằng bản giả

const { aiCooldown } = await import('../ai/cooldown.js');
const { aiLimiter } = await import('../ai/concurrency.js');
const { generateJson } = await import('../ai/provider.js');

const realFetch = globalThis.fetch;
let calls = 0;

const okBody = () =>
    JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    });
const reply = (status, body = '', headers = {}) => new Response(body, { status, headers });
const dailyBody = JSON.stringify({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] }
});

function fakeFetch(...steps) {
    calls = 0;
    globalThis.fetch = async () => {
        const step = steps[Math.min(calls, steps.length - 1)];
        calls++;
        const r = typeof step === 'function' ? await step() : step;
        if (r instanceof Error) throw r;
        return r;
    };
}
const ask = () => generateJson({ prompt: 'xin chào' });
const failureOf = async (p) => p.then(() => assert.fail('đáng lẽ phải lỗi'), (e) => e);

beforeEach(() => aiCooldown.reset());
afterEach(() => {
    globalThis.fetch = realFetch;
    assert.equal(aiLimiter.stats().active, 0, 'lượt chạy đồng thời phải được trả lại sau mỗi lời gọi');
});

test('thành công: trả dữ liệu và số token', async () => {
    fakeFetch(reply(200, okBody()));
    const r = await ask();
    assert.deepEqual(r.data, { ok: true });
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(aiCooldown.remainingMs(), 0);
});

test('429 kèm Retry-After: báo lỗi có thể thử lại, mang thời gian chờ và bật tạm nghỉ toàn cục', async () => {
    fakeFetch(reply(429, '{}', { 'retry-after': '30' }));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-rate-limit');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 30_000);
    const remaining = aiCooldown.remainingMs();
    assert.ok(remaining > 29_000 && remaining <= 30_000, `còn ${remaining} ms`);
});

test('đang tạm nghỉ: lời gọi sau thất bại ngay và KHÔNG gửi thêm request lên Gemini', async () => {
    fakeFetch(reply(429, '{}', { 'retry-after': '30' }), reply(200, okBody()));
    await failureOf(ask());
    assert.equal(calls, 1);

    for (let i = 0; i < 5; i++) {
        const err = await failureOf(ask());
        assert.equal(err.code, 'ai-cooldown');
        assert.equal(err.retryable, true);
        assert.ok(err.retryAfterMs > 0);
    }
    assert.equal(calls, 1, 'năm lời gọi trong lúc tạm nghỉ không được gửi request nào');
});

test('hết thời gian tạm nghỉ thì gọi lại bình thường', async () => {
    fakeFetch(reply(429, '{}', { 'retry-after': '30' }), reply(200, okBody()));
    await failureOf(ask());
    aiCooldown.reset(); // giả lập đã hết thời gian nghỉ
    const r = await ask();
    assert.deepEqual(r.data, { ok: true });
    assert.equal(calls, 2);
});

test('429 không kèm gợi ý: tạm nghỉ mặc định 1 phút', async () => {
    fakeFetch(reply(429, 'Too Many Requests'));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-rate-limit');
    assert.equal(err.retryAfterMs, null);
    const remaining = aiCooldown.remainingMs();
    assert.ok(remaining > 59_000 && remaining <= 60_000, `còn ${remaining} ms`);
});

test('hết quota trong ngày: không thể thử lại, tạm nghỉ dài', async () => {
    fakeFetch(reply(429, dailyBody));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-quota-daily');
    assert.equal(err.retryable, false);
    assert.ok(aiCooldown.remainingMs() > 25 * 60_000);
});

test('timeout: lỗi có thể thử lại, KHÔNG làm cả hệ thống tạm nghỉ', async () => {
    fakeFetch(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-network');
    assert.equal(err.retryable, true);
    assert.equal(aiCooldown.remainingMs(), 0);
});

test('lỗi mạng: có thể thử lại, không tạm nghỉ', async () => {
    fakeFetch(new Error('fetch failed'));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-network');
    assert.equal(err.retryable, true);
    assert.equal(aiCooldown.remainingMs(), 0);
});

test('lỗi 503: có thể thử lại, giữ gợi ý Retry-After, không tạm nghỉ toàn cục', async () => {
    fakeFetch(reply(503, 'unavailable', { 'retry-after': '12' }));
    const err = await failureOf(ask());
    assert.equal(err.code, 'ai-http');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 12_000);
    assert.equal(aiCooldown.remainingMs(), 0);
});

test('lỗi 400: không thử lại', async () => {
    fakeFetch(reply(400, 'bad request'));
    const err = await failureOf(ask());
    assert.equal(err.retryable, false);
    assert.equal(aiCooldown.remainingMs(), 0);
});

test('lời gọi đang chờ trong hàng đợi gặp lúc Gemini vừa báo 429 thì không gửi request', async () => {
    fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 20)); // giữ lượt duy nhất đủ lâu để lời gọi thứ hai phải xếp hàng
        return reply(429, '{}', { 'retry-after': '30' });
    });
    const [first, second] = await Promise.allSettled([ask(), ask()]);
    assert.equal(first.status, 'rejected');
    assert.equal(first.reason.code, 'ai-rate-limit');
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.code, 'ai-cooldown');
    assert.equal(calls, 1, 'lời gọi thứ hai chờ xong thấy đang tạm nghỉ nên không gọi Gemini');
});
