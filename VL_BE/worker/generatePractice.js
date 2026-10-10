// Chức năng: job "generate_practice" (Phase 5, Weakness -> Practice) - lấy các câu người học từng sai ở một chủ đề, tra ngược đoạn tài liệu nguồn,
// nhờ AI soạn câu luyện MỚI bám đúng đoạn đó, kiểm tra bằng luật, lưu (origin 'ai-practice', chưa duyệt) + đáp án, chốt AI credits.
// Lỗi được ném lên processJob (jobRunner.js) để retry/dead-letter và hoàn credits.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { generateJson } from '../ai/provider.js';
import { splitForStorage, stemKey, validateQuestions } from '../ai/questionRules.js';
import {
    MAX_FOCUS_MISTAKES,
    OVERSHOOT,
    WEAKNESS_SYSTEM_PROMPT,
    buildHints,
    buildWeaknessPrompt,
    pickFocusMistakes,
    resolveFocus,
    selectChunks
} from '../ai/weaknessRules.js';
import { QuotaError, attemptKey, reserveCredits, settleCredits } from '../credits.js';
import { creditLimits, getPlan } from '../config/plans.js';
import { UserError } from './extract.js';

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

export async function processGeneratePractice(job) {
    const db = getDb();
    const jobRef = db.collection('jobs').doc(job.id);
    const uid = job.ownerId;

    // 1. Câu từng sai của chủ đề (đang ôn trước, sai nhiều trước)
    const mSnap = await db.collection('users').doc(uid).collection('mistakes').where('topicId', '==', job.topicId).limit(100).get();
    const mistakes = pickFocusMistakes(
        mSnap.docs.map((d) => d.data()),
        MAX_FOCUS_MISTAKES
    );
    if (!mistakes.length) throw new UserError('Chủ đề này chưa có câu sai nào để làm căn cứ tạo câu luyện');

    // 2. Nguồn của câu gốc (bản chụp trong sổ lỗi sai không lưu nguồn). Chỉ dùng câu thuộc tài liệu của chính người dùng.
    const qSnaps = await db.getAll(...mistakes.map((m) => db.collection('questions').doc(m.questionId)));
    const sources = new Map();
    for (const s of qSnaps) {
        if (!s.exists) continue;
        const d = s.data();
        if (d.ownerId !== uid || !d.source?.documentId || !d.source?.chunkId) continue;
        sources.set(s.id, { documentId: d.source.documentId, chunkId: d.source.chunkId, pageNumber: d.source.pageNumber });
    }
    const focus = resolveFocus(mistakes, sources);
    if (!focus) {
        throw new UserError('Không tìm thấy tài liệu nguồn của các câu sai này (tài liệu có thể đã bị xóa, hoặc câu không phải của bạn)');
    }

    // 3. Đoạn tài liệu: trang có câu sai và trang kế bên
    const docRef = db.collection('documents').doc(focus.documentId);
    const docSnap = await docRef.get();
    if (!docSnap.exists || docSnap.data().ownerId !== uid) throw new UserError('Tài liệu nguồn không còn tồn tại');
    if (docSnap.data().status !== 'ready') throw new UserError('Tài liệu nguồn chưa sẵn sàng');

    const cSnap = await docRef.collection('chunks').where('pageNumber', 'in', focus.pages).get();
    const loaded = cSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const chunks = selectChunks(loaded, focus.chunkIds);
    if (!chunks.length) throw new UserError('Không còn nội dung tài liệu để tạo câu luyện');
    const chunkIndex = new Map(chunks.map((c) => [c.id, c]));

    // 4. Không sinh trùng: câu đã có của người dùng trong chủ đề + chính các câu sai làm căn cứ (retry thì bỏ qua câu do chính job này tạo)
    const existing = await db.collection('questions').where('ownerId', '==', uid).where('topicId', '==', job.topicId).limit(300).get();
    const seenKeys = [
        ...existing.docs.filter((d) => d.data().jobId !== job.id).map((d) => stemKey(d.data().stem)),
        ...mistakes.map((m) => stemKey(m.stem))
    ];

    // Giữ chỗ credits ngay khi bắt đầu chạy (job còn trong hàng đợi không khóa credit)
    const owner = await db.collection('users').doc(uid).get();
    try {
        await reserveCredits({ uid, jobId: attemptKey(job), amount: job.count, limit: creditLimits(getPlan(owner.data()?.plan)) });
    } catch (err) {
        if (err instanceof QuotaError) throw new UserError(err.message, 'quota-credits');
        throw err;
    }

    // 5. Gọi AI một lần (đoạn nguồn chỉ vừa một lô), kiểm tra bằng luật
    const ask = Math.ceil(job.count * OVERSHOOT);
    const result = await generateJson({
        system: WEAKNESS_SYSTEM_PROMPT,
        prompt: buildWeaknessPrompt({ chunks, ask, types: job.types, hints: buildHints(mistakes) }),
        temperature: 0.5,
        maxOutputTokens: 4096
    });
    const list = Array.isArray(result.data?.questions) ? result.data.questions : [];
    const checked = validateQuestions(list, { chunkIndex, allowedTypes: job.types, seenKeys });
    const finalList = checked.accepted.slice(0, job.count);
    if (!finalList.length) {
        // Không phải lỗi tạm thời: thử lại chỉ đốt thêm lượt gọi AI
        throw new UserError('AI không tạo được câu luyện hợp lệ nào từ đoạn tài liệu này. Thử lại sau.', 'no-valid-questions');
    }

    // 6. Lưu. id cố định theo job nên retry ghi đè đúng chỗ, không tạo câu trùng
    const batch = db.batch();
    finalList.forEach((q, n) => {
        const id = `${job.id}_${String(n).padStart(3, '0')}`;
        const { question, key } = splitForStorage({ ...q, source: { ...q.source, documentId: focus.documentId } });
        batch.set(db.collection('questions').doc(id), {
            ownerId: uid,
            topicId: job.topicId,
            ...question,
            reviewStatus: 'draft',
            origin: 'ai-practice',
            jobId: job.id,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        });
        batch.set(db.collection('answerKeys').doc(id), { ownerId: uid, ...key });
    });
    await batch.commit();

    // 7. Chốt credits: tạo được bao nhiêu câu thì trừ bấy nhiêu, hoàn phần còn lại (idempotent)
    await settleCredits({ uid, jobId: attemptKey(job), actual: finalList.length });

    await jobRef.update({
        status: 'done',
        progress: { done: 1, total: 1 },
        result: {
            requested: job.count,
            generated: list.length,
            saved: finalList.length,
            rejected: checked.rejected,
            basedOnMistakes: mistakes.length,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens
        },
        error: null,
        updatedAt: FieldValue.serverTimestamp()
    });
    log('info', 'Tạo câu luyện phần yếu xong', { jobId: job.id, topicId: job.topicId, saved: finalList.length, basedOnMistakes: mistakes.length });
}
