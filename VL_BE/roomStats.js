// Chức năng: thống kê của phòng (Phase 5) - cộng dồn đúng/sai từng câu vào rooms/{code}/questionStats/{questionId} và số bài đã nộp vào rooms/{code}.submittedCount mỗi khi có người nộp bài.
// Nhờ cộng dồn sẵn nên chủ phòng xem Heatmap chỉ tốn vài lượt đọc, không phải đọc lại từng bài làm.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './firebase.js';
import { statIncrements } from './quiz/heatmapRules.js';

const roomRef = (code) => getDb().collection('rooms').doc(code);

// Gọi ĐÚNG MỘT lần cho mỗi bài vừa chấm xong (finalizeAttempt chỉ gọi khi bài chưa từng được nộp).
// questions: các câu của lượt làm; statuses: result.statuses của lượt làm.
export async function recordRoomStats({ code, questions, statuses }) {
    const inc = statIncrements(questions, statuses);
    const ref = roomRef(code);
    const batch = getDb().batch();
    batch.set(ref, { submittedCount: FieldValue.increment(1) }, { merge: true });
    for (const [id, d] of Object.entries(inc)) {
        batch.set(
            ref.collection('questionStats').doc(id),
            {
                answered: FieldValue.increment(d.answered),
                wrong: FieldValue.increment(d.wrong),
                skipped: FieldValue.increment(d.skipped),
                updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
        );
    }
    await batch.commit();
}

// Đọc thống kê từng câu của phòng -> { [questionId]: { answered, wrong, skipped } }
export async function loadRoomStats(code) {
    const snap = await roomRef(code).collection('questionStats').limit(200).get();
    const out = {};
    for (const d of snap.docs) {
        const s = d.data();
        out[d.id] = { answered: s.answered || 0, wrong: s.wrong || 0, skipped: s.skipped || 0 };
    }
    return out;
}
