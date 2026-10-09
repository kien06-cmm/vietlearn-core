// Chức năng: mức thành thạo theo chủ đề (Phase 5) - truy cập Firestore users/{uid}/topicStats/{topicId}. Cộng kết quả sau khi nộp bài hoặc ôn tập.
// Để subcollection theo người dùng nên người này không đọc được dữ liệu người kia và truy vấn chỉ cần chỉ mục đơn.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './firebase.js';
import { applyOutcomes } from './quiz/masteryRules.js';

export const statsCol = (uid) => getDb().collection('users').doc(uid).collection('topicStats');

// outcomes: Map(topicId -> chuỗi kết quả) từ outcomesByTopic(). Cộng cho tất cả chủ đề trong MỘT transaction
// (một lượt làm tối đa 100 câu nên tối đa 100 chủ đề, dưới giới hạn 500 ghi của Firestore). Trả về số chủ đề đã cập nhật.
export async function recordTopicOutcomes({ uid, outcomes, nowMs = Date.now() }) {
    const ids = [...(outcomes?.keys() || [])];
    if (!ids.length) return 0;

    const refs = ids.map((id) => statsCol(uid).doc(id));
    await getDb().runTransaction(async (tx) => {
        const snaps = await tx.getAll(...refs);
        snaps.forEach((snap, i) => {
            const data = applyOutcomes(snap.exists ? snap.data() : null, outcomes.get(ids[i]), nowMs);
            tx.set(
                refs[i],
                {
                    topicId: ids[i],
                    ...data,
                    ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
                    updatedAt: FieldValue.serverTimestamp()
                },
                { merge: true }
            );
        });
    });
    return ids.length;
}
