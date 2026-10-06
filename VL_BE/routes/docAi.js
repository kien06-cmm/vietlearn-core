// Chức năng: API tóm tắt và hỏi đáp tài liệu (Phase 3) - chỉ trả lời từ nội dung tài liệu, mọi ý đều kèm nguồn (trang + đoạn).
// Mỗi lần gọi AI đều giữ chỗ AI credits trước và chốt/hoàn sau (AI lỗi => hoàn toàn bộ). Gắn vào đường dẫn /documents.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireOwner } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { CREDIT_COST, getPlan } from '../config/plans.js';
import { QuotaError, reserveCredits, settleCredits } from '../credits.js';
import { AIError, generateJson } from '../ai/provider.js';
import {
    MAX_CHUNKS_READ,
    MAX_SUMMARY_CHARS,
    QA_SYSTEM_PROMPT,
    buildAskPrompt,
    buildSummaryPrompt,
    parseAnswer,
    parseSummary,
    rankChunks,
    sampleChunks
} from '../ai/docQa.js';
import { captureError } from '../monitoring.js';

const router = Router();

function fail(res, status, message, code) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });
}

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'docai', message, ...extra }));
}

const iso = (ts) => (ts?.toDate ? ts.toDate().toISOString() : null);

// Chỉ chủ tài liệu (hoặc admin) được tóm tắt/hỏi đáp
const ownerOnly = requireOwner(async (req) => {
    const snap = await getDb().collection('documents').doc(req.params.id).get();
    req.docSnap = snap.exists ? snap : null;
    return req.docSnap ? req.docSnap.data().ownerId : null;
});

// Đọc chunk của tài liệu (tối đa MAX_CHUNKS_READ để giới hạn lượt đọc Firestore). partial=true: tài liệu dài hơn mức đọc.
async function loadChunks(docRef) {
    const snap = await docRef.collection('chunks').limit(MAX_CHUNKS_READ).get();
    const chunks = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index);
    return { chunks, partial: snap.size >= MAX_CHUNKS_READ };
}

// Giữ chỗ credits -> chạy work() -> chốt. work() ném lỗi => hoàn toàn bộ. Chốt lỗi thì chỉ ghi log (không làm hỏng phản hồi).
async function withCredits({ uid, plan, cost, kind, work }) {
    const jobId = `${kind}_${randomUUID()}`;
    const { period } = await reserveCredits({ uid, jobId, amount: cost, limit: plan.aiCreditsPerMonth });

    let actual = 0;
    try {
        const result = await work();
        actual = cost;
        return result;
    } finally {
        await settleCredits({ uid, jobId, period, reserved: cost, actual }).catch((err) => {
            captureError(err, { jobId, kind });
            log('error', 'Không chốt được credits', { jobId, kind, error: err.message });
        });
    }
}

// Đổi lỗi quota/AI thành phản hồi cho người dùng; lỗi khác để middleware lỗi chung xử lý
function handleAiError(res, err) {
    if (err instanceof QuotaError) return fail(res, 402, err.message, 'quota-credits');
    if (err instanceof AIError) {
        log('error', 'AI lỗi', { code: err.code, error: err.message });
        const status = err.code === 'ai-no-key' ? 503 : 502;
        return fail(res, status, 'AI tạm thời chưa xử lý được, vui lòng thử lại sau', 'ai-unavailable');
    }
    throw err;
}

const aiLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'document-ai' });
const summarizing = new Set(); // chặn bấm "Tóm tắt" liên tục (tránh bị trừ credits hai lần)

const publicSummary = (s) => ({ overview: s.overview, points: s.points, createdAt: iso(s.createdAt) });

// ---------------------------------------------------------------------------
// Tóm tắt: xem bản đã lưu (miễn phí) / tạo mới (tốn credits)
// ---------------------------------------------------------------------------
router.get('/:id/summary', ownerOnly, (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');
    const s = req.docSnap.data().summary;
    res.status(200).json({ status: 'success', summary: s ? publicSummary(s) : null });
});

const summarySchema = z.object({ force: z.boolean().optional() }).strict();

router.post('/:id/summary', aiLimiter, ownerOnly, async (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');
    const parsed = summarySchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const d = req.docSnap.data();
    if (d.status !== 'ready') return fail(res, 409, 'Tài liệu chưa sẵn sàng', 'not-ready');

    // Đã có bản tóm tắt thì trả lại, không tốn credits (trừ khi người dùng chủ động "tóm tắt lại")
    if (d.summary && !parsed.data.force) {
        return res.status(200).json({ status: 'success', summary: publicSummary(d.summary), cached: true });
    }

    const lockKey = `${req.actor.id}:${req.docSnap.id}`;
    if (summarizing.has(lockKey)) return fail(res, 429, 'Đang tóm tắt tài liệu này, vui lòng chờ', 'busy');
    summarizing.add(lockKey);

    try {
        const { chunks } = await loadChunks(req.docSnap.ref);
        if (!chunks.length) return fail(res, 409, 'Tài liệu không có nội dung chữ để tóm tắt', 'no-text');

        const picked = sampleChunks(chunks, MAX_SUMMARY_CHARS);
        const chunkIndex = new Map(picked.map((c) => [c.id, c]));
        const plan = getPlan(req.profile.plan);

        const summary = await withCredits({
            uid: req.actor.id,
            plan,
            cost: CREDIT_COST.summary,
            kind: 'summary',
            work: async () => {
                const { data, usage } = await generateJson({
                    system: QA_SYSTEM_PROMPT,
                    prompt: buildSummaryPrompt(picked),
                    temperature: 0.2,
                    maxOutputTokens: 2048
                });
                log('info', 'Tóm tắt xong', { documentId: req.docSnap.id, ...usage });
                const result = parseSummary(data, chunkIndex);
                // Kết quả không dùng được (thiếu ý/sai nguồn) coi như AI lỗi => hoàn credits
                if (!result) throw new AIError('AI trả về bản tóm tắt không dùng được', { retryable: true, code: 'ai-bad-output' });
                return result;
            }
        });

        await req.docSnap.ref.update({ summary: { ...summary, createdAt: FieldValue.serverTimestamp() } });
        res.status(200).json({
            status: 'success',
            summary: { ...summary, createdAt: new Date().toISOString() },
            cached: false
        });
    } catch (err) {
        return handleAiError(res, err);
    } finally {
        summarizing.delete(lockKey);
    }
});

// ---------------------------------------------------------------------------
// Hỏi đáp: chỉ trả lời từ nội dung tài liệu, có trích nguồn
// ---------------------------------------------------------------------------
const askSchema = z.object({ question: z.string().trim().min(3).max(500) }).strict();

router.post('/:id/ask', aiLimiter, ownerOnly, async (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Câu hỏi không hợp lệ (3-500 ký tự)');

    if (req.docSnap.data().status !== 'ready') return fail(res, 409, 'Tài liệu chưa sẵn sàng', 'not-ready');

    const { question } = parsed.data;
    const { chunks, partial } = await loadChunks(req.docSnap.ref);

    // Chọn đoạn liên quan bằng luật (không tốn AI). Không đoạn nào chứa từ khóa => trả lời "không có" luôn, không trừ credits.
    const relevant = rankChunks(question, chunks);
    if (!relevant.length) {
        return res.status(200).json({ status: 'success', found: false, answer: '', sources: [], partial });
    }

    const chunkIndex = new Map(relevant.map((c) => [c.id, c]));
    const plan = getPlan(req.profile.plan);

    try {
        const result = await withCredits({
            uid: req.actor.id,
            plan,
            cost: CREDIT_COST.ask,
            kind: 'ask',
            work: async () => {
                const { data, usage } = await generateJson({
                    system: QA_SYSTEM_PROMPT,
                    prompt: buildAskPrompt({ chunks: relevant, question }),
                    temperature: 0.1,
                    maxOutputTokens: 1024
                });
                log('info', 'Hỏi đáp xong', { documentId: req.docSnap.id, ...usage });
                return parseAnswer(data, chunkIndex); // không có căn cứ hợp lệ => found:false
            }
        });
        res.status(200).json({ status: 'success', ...result, partial });
    } catch (err) {
        return handleAiError(res, err);
    }
});

export default router;
