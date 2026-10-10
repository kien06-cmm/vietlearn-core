// Chức năng: job "generate_questions" - đọc chunk của tài liệu, gọi AI theo lô, kiểm tra bằng luật, lưu câu hỏi (nháp) + đáp án.
// Credits: giữ chỗ khi job BẮT ĐẦU chạy (theo khóa của lần thử này); thành công thì chốt đúng số câu lưu được;
// thất bại thì jobRunner.settleFailure giải phóng phần giữ chỗ. Job đang nằm trong hàng đợi không khóa credit.
// Lỗi tạm thời ném lên processJob để retry; lỗi do người dùng (UserError) thất bại ngay.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { generateJson } from '../ai/provider.js';
import { SYSTEM_PROMPT, buildPrompt, planBatches, splitForStorage, stemKey, validateQuestions } from '../ai/questionRules.js';
import { creditLimits, getPlan } from '../config/plans.js';
import { QuotaError, attemptKey, reserveCredits, settleCredits } from '../credits.js';
import { UserError } from './extract.js';

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

// Chunk của tài liệu (có thể giới hạn theo khoảng trang), sắp theo trang
async function loadChunks(docRef, { pageFrom, pageTo }) {
    let query = docRef.collection('chunks');
    if (pageFrom) query = query.where('pageNumber', '>=', pageFrom);
    if (pageTo) query = query.where('pageNumber', '<=', pageTo);
    const snap = await query.get();
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index);
}

export async function processGenerateQuestions(job) {
    const db = getDb();
    const jobRef = db.collection('jobs').doc(job.id);

    const docSnap = await db.collection('documents').doc(job.documentId).get();
    if (!docSnap.exists || docSnap.data().ownerId !== job.ownerId) throw new UserError('Tài liệu không còn tồn tại');
    if (docSnap.data().status !== 'ready') throw new UserError('Tài liệu chưa sẵn sàng');

    const chunks = await loadChunks(docSnap.ref, job);
    if (!chunks.length) throw new UserError('Không có nội dung chữ để tạo câu hỏi');

    // Giữ chỗ credits ngay khi bắt đầu chạy. Hết credits thì thất bại ngay, không thử lại.
    const owner = await db.collection('users').doc(job.ownerId).get();
    const plan = getPlan(owner.data()?.plan);
    try {
        await reserveCredits({ uid: job.ownerId, jobId: attemptKey(job), amount: job.count, limit: creditLimits(plan) });
    } catch (err) {
        if (err instanceof QuotaError) throw new UserError(err.message, 'quota-credits');
        throw err;
    }

    // Đề đã có của tài liệu này (trừ câu do chính job này tạo ở lần chạy trước) để không sinh trùng
    const existing = await db.collection('questions').where('source.documentId', '==', job.documentId).limit(300).get();
    const seenKeys = existing.docs.filter((d) => d.data().jobId !== job.id).map((d) => stemKey(d.data().stem));

    const chunkIndex = new Map(chunks.map((c) => [c.id, c]));
    const batches = planBatches(chunks, job.count);
    const accepted = [];
    const rejected = {};
    const usage = { inputTokens: 0, outputTokens: 0 };
    let generated = 0;

    for (let i = 0; i < batches.length && accepted.length < job.count; i++) {
        const { chunks: batchChunks, ask } = batches[i];
        const result = await generateJson({
            system: SYSTEM_PROMPT,
            prompt: buildPrompt({ chunks: batchChunks, ask, types: job.types }),
            temperature: 0.4,
            maxOutputTokens: 4096
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;

        const list = Array.isArray(result.data?.questions) ? result.data.questions : [];
        generated += list.length;
        const checked = validateQuestions(list, { chunkIndex, allowedTypes: job.types, seenKeys });
        accepted.push(...checked.accepted);
        for (const [reason, n] of Object.entries(checked.rejected)) rejected[reason] = (rejected[reason] || 0) + n;

        // Ghi tiến độ theo lô, đồng thời cộng dồn số lần gọi và token trên job (làm mới updatedAt để recoverStaleJobs không tưởng worker đã chết)
        await jobRef.update({
            progress: { done: i + 1, total: batches.length },
            'aiUsage.calls': FieldValue.increment(1),
            'aiUsage.inputTokens': FieldValue.increment(result.usage.inputTokens),
            'aiUsage.outputTokens': FieldValue.increment(result.usage.outputTokens),
            updatedAt: FieldValue.serverTimestamp()
        });
    }

    const finalList = accepted.slice(0, job.count);
    if (!finalList.length) {
        // Không phải lỗi tạm thời: thử lại chỉ đốt thêm lượt gọi AI, nên báo người dùng ngay
        throw new UserError('AI không tạo được câu hỏi hợp lệ nào từ nội dung này. Hãy thử chọn phạm vi trang khác hoặc giảm số câu.', 'no-valid-questions');
    }

    // id cố định theo job => retry ghi đè đúng chỗ, không tạo câu trùng
    const batch = db.batch();
    finalList.forEach((q, n) => {
        const id = `${job.id}_${String(n).padStart(3, '0')}`;
        const { question, key } = splitForStorage({ ...q, source: { ...q.source, documentId: job.documentId } });
        batch.set(db.collection('questions').doc(id), {
            ownerId: job.ownerId,
            topicId: job.topicId,
            ...question,
            reviewStatus: 'draft',
            jobId: job.id,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        });
        batch.set(db.collection('answerKeys').doc(id), { ownerId: job.ownerId, ...key });
    });
    await batch.commit();

    // Chốt credits: dùng bao nhiêu câu thì trừ bấy nhiêu, hoàn phần còn lại (idempotent)
    await settleCredits({ uid: job.ownerId, jobId: attemptKey(job), actual: finalList.length });

    await jobRef.update({
        status: 'done',
        progress: { done: batches.length, total: batches.length },
        result: { requested: job.count, generated, saved: finalList.length, rejected, ...usage },
        error: null,
        updatedAt: FieldValue.serverTimestamp()
    });
    log('info', 'Sinh câu hỏi xong', { jobId: job.id, saved: finalList.length, generated, rejected, ...usage });
}
