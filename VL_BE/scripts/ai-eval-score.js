// Chức năng: đọc báo cáo do ai-eval.js tạo (sau khi bạn đã tick chấm tay) và tính tỷ lệ câu OK / SAI / BỊA / TRÙNG / DỞ.
// Chạy: node scripts/ai-eval-score.js reports/ai-eval-....md
import { readFile } from 'node:fs/promises';

const LABELS = ['OK', 'SAI', 'BỊA', 'TRÙNG', 'DỞ'];
const TARGET = { bad: 10, dup: 10 }; // % tối đa gợi ý cho V1

const path = process.argv[2];
if (!path) {
    console.error('Cách dùng: node scripts/ai-eval-score.js <file-báo-cáo.md>');
    process.exit(1);
}

const text = await readFile(path, 'utf8');
const docs = text.split(/^## Tài liệu: /m).slice(1);

const total = { questions: 0, ungraded: 0, OK: 0, SAI: 0, 'BỊA': 0, 'TRÙNG': 0, 'DỞ': 0 };
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-');

for (const doc of docs) {
    const name = doc.split('\n')[0].trim();
    const questions = doc.split(/^### #/m).slice(1);
    const c = { questions: questions.length, ungraded: 0, OK: 0, SAI: 0, 'BỊA': 0, 'TRÙNG': 0, 'DỞ': 0 };

    for (const q of questions) {
        const ticked = LABELS.filter((l) => new RegExp(`^- \\[[xX]\\] ${l}(?=\\s|$)`, 'm').test(q));
        if (!ticked.length) c.ungraded++;
        for (const l of ticked) c[l]++;
    }

    const graded = c.questions - c.ungraded;
    console.log(`\n${name}`);
    console.log(`  Đã chấm ${graded}/${c.questions} câu`);
    for (const l of LABELS) console.log(`  ${l.padEnd(6)} ${String(c[l]).padStart(3)}  (${pct(c[l], graded)})`);

    for (const k of Object.keys(total)) total[k] += c[k];
}

const graded = total.questions - total.ungraded;
const bad = total.SAI + total['BỊA'];
console.log('\n=== TỔNG ===');
console.log(`Đã chấm ${graded}/${total.questions} câu`);
for (const l of LABELS) console.log(`${l.padEnd(6)} ${String(total[l]).padStart(3)}  (${pct(total[l], graded)})`);
console.log(`SAI + BỊA: ${bad} câu (${pct(bad, graded)}) - mục tiêu < ${TARGET.bad}%`);
console.log(`TRÙNG: ${total['TRÙNG']} câu (${pct(total['TRÙNG'], graded)}) - mục tiêu < ${TARGET.dup}%`);

if (total.ungraded) console.log(`\nCòn ${total.ungraded} câu chưa chấm, kết quả chưa đầy đủ.`);
else if (graded) {
    const ok = (bad / graded) * 100 < TARGET.bad && (total['TRÙNG'] / graded) * 100 < TARGET.dup;
    console.log(ok ? '\nĐẠT mục tiêu chất lượng V1.' : '\nCHƯA đạt: xem lại prompt, luật kiểm tra hoặc mô hình AI.');
}
