// Chức năng: lớp trừu tượng nhà cung cấp AI. Business logic chỉ gọi generateJson(); đổi nhà cung cấp/model bằng biến môi trường.

const TIMEOUT_MS = 60_000;

// Lỗi gọi AI. retryable=true: lỗi tạm thời (429, 5xx, mạng) nên thử lại
export class AIError extends Error {
    constructor(message, { retryable = false, code = 'ai-error' } = {}) {
        super(message);
        this.retryable = retryable;
        this.code = code;
    }
}

// Gỡ rào ```json nếu model lỡ thêm vào
function parseJson(text) {
    const clean = String(text || '')
        .replace(/^\s*```(?:json)?/i, '')
        .replace(/```\s*$/, '')
        .trim();
    try {
        return JSON.parse(clean);
    } catch {
        throw new AIError('AI trả về dữ liệu không phải JSON hợp lệ', { retryable: true, code: 'ai-bad-json' });
    }
}

// Gemini
async function gemini({ system, prompt, temperature, maxOutputTokens }) {
    const key = process.env.AI_API_KEY;
    if (!key) throw new AIError('Thiếu biến môi trường AI_API_KEY', { code: 'ai-no-key' });
    const model = process.env.AI_MODEL || 'gemini-3.5-flash-lite';

    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    let res;
    try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (err) {
        throw new AIError(`Không gọi được AI: ${err.message}`, { retryable: true, code: 'ai-network' });
    }

    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        const retryable = res.status === 429 || res.status >= 500;
        throw new AIError(`AI lỗi ${res.status}: ${detail}`, { retryable, code: res.status === 429 ? 'ai-rate-limit' : 'ai-http' });
    }

    const json = await res.json();
    if (json.promptFeedback?.blockReason) {
        throw new AIError(`AI từ chối nội dung (${json.promptFeedback.blockReason})`, { code: 'ai-blocked' });
    }
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) {
        throw new AIError(`AI không trả nội dung (${candidate?.finishReason || 'unknown'})`, { retryable: true, code: 'ai-empty' });
    }
    if (candidate.finishReason === 'MAX_TOKENS') {
        throw new AIError('AI bị cắt giữa chừng do hết token đầu ra', { code: 'ai-truncated' });
    }

    return {
        data: parseJson(text),
        usage: {
            inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0
        }
    };
}

const PROVIDERS = { gemini };

// Ghi log mỗi lần gọi AI (số request, token, lỗi) để theo dõi chi phí và quota. Không ghi nội dung prompt hay key.
function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'ai', message, ...extra }));
}

// Gọi AI, trả JSON. Kết quả: { data, usage: { inputTokens, outputTokens } }
export async function generateJson({ system = '', prompt, temperature = 0.4, maxOutputTokens = 4096 }) {
    const name = process.env.AI_PROVIDER || 'gemini';
    const provider = PROVIDERS[name];
    if (!provider) throw new AIError(`Nhà cung cấp AI không hỗ trợ: ${name}`, { code: 'ai-provider' });

    const started = Date.now();
    try {
        const result = await provider({ system, prompt, temperature, maxOutputTokens });
        log('info', 'Gọi AI thành công', { provider: name, ms: Date.now() - started, ...result.usage });
        return result;
    } catch (err) {
        log('warn', 'Gọi AI lỗi', { provider: name, ms: Date.now() - started, code: err.code || 'unknown', retryable: !!err.retryable });
        throw err;
    }
}
