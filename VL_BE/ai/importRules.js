// Chức năng: luật thuần để NHẬP đề trắc nghiệm có sẵn (Word/TXT dạng "Câu 1... A. B. C. D. Đáp án: B" và Excel theo file mẫu).
// Đọc bằng luật, KHÔNG gọi AI nên không tốn credits và không bịa nội dung. Mỗi câu vẫn qua parseQuestion (luật chung với câu AI sinh).
// Không đọc file/mạng/DB nên dễ test. Việc đọc file thật nằm ở ai/importFile.js.
import { isDuplicateStem, parseQuestion, stemKey } from './questionRules.js';

export const MAX_IMPORT_QUESTIONS = 200; // tối đa 200 câu mỗi lần nhập (vừa một batch ghi Firestore)
const LETTERS = ['A', 'B', 'C', 'D'];
const IMPORT_CHUNK_ID = 'import'; // câu nhập từ file không có đoạn nguồn; parseQuestion vẫn đòi chunkId nên dùng giá trị giữ chỗ

// Lý do parseQuestion từ chối -> câu giải thích cho giáo viên
const REASONS = {
    'invalid-schema': 'Đề bài cần 10-500 ký tự, mỗi lựa chọn 1-200 ký tự, giải thích tối đa 600 ký tự',
    'missing-answer': 'Thiếu đáp án đúng',
    'duplicate-options': 'Có hai lựa chọn giống hệt nhau',
    'invalid-answer': 'Đáp án không hợp lệ'
};

// Bỏ dấu + chữ thường để so tên cột / nội dung
const fold = (s) =>
    String(s ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

// Ghép thành câu thô cho parseQuestion. Trả { label, raw } hoặc { label, error }.
function buildItem(label, { stem, options, answerIndex, explanation }) {
    const missing = LETTERS.filter((_, i) => !String(options[i] ?? '').trim());
    if (!String(stem ?? '').trim()) return { label, error: 'Thiếu nội dung câu hỏi' };
    if (missing.length) return { label, error: `Thiếu lựa chọn ${missing.join(', ')} (cần đủ 4 lựa chọn A, B, C, D)` };
    if (answerIndex === null) return { label, error: 'Thiếu đáp án đúng' };
    if (answerIndex < 0) return { label, error: 'Đáp án không hợp lệ (dùng A, B, C hoặc D)' };
    const expl = String(explanation ?? '').trim().slice(0, 600);
    return {
        label,
        raw: {
            type: 'single',
            chunkId: IMPORT_CHUNK_ID,
            stem: String(stem).trim(),
            options: options.map((o) => String(o).trim()),
            correct: answerIndex,
            ...(expl ? { explanation: expl } : {})
        }
    };
}

// ---------------------------------------------------------------------------
// Word / TXT: văn bản thô -> danh sách câu
// ---------------------------------------------------------------------------
const Q_START = /^\s*(?:câu|cau|question)\s*(\d+)\s*(?:\([^)]*\))?\s*[.:)–-]\s*(.*)$/iu;
const NUM_START = /^\s*(\d{1,3})\s*[.)]\s+(.+)$/u;
const OPT_START = /^\s*\(?([A-Da-d])\s*[.):]\s*(.*)$/u;
const ANS =
    /^\s*(?:(?:đáp án|dap an|answer)(?:\s+đúng)?\s*[:：.-]?|đa\s*[:：.-])\s*\(?([A-Da-d])(?![\p{L}\p{N}])/iu;
const EXPL = /^\s*(?:giải thích|giai thich|lời giải|loi giai|hướng dẫn giải|explanation)\s*[:：.]\s*(.*)$/iu;

// "A. 1 B. 2 C. 3 D. 4" trên cùng một dòng -> 4 lựa chọn. Chỉ tách khi dòng bắt đầu bằng lựa chọn và các chữ cái nối tiếp nhau.
function splitInlineOptions(line) {
    const marks = [];
    const re = /(?:^|\s)\(?([A-Da-d])[.)]\s+/gu;
    let m;
    while ((m = re.exec(line))) {
        marks.push({ letter: m[1].toUpperCase(), start: m.index, textStart: m.index + m[0].length });
    }
    if (!marks.length || marks[0].start !== 0) return null;

    const chain = [marks[0]];
    for (const mk of marks.slice(1)) {
        const prev = chain[chain.length - 1];
        if (LETTERS.indexOf(mk.letter) === LETTERS.indexOf(prev.letter) + 1) chain.push(mk);
    }
    if (chain.length < 2) return null;
    return chain.map((mk, i) => ({
        letter: mk.letter,
        text: line.slice(mk.textStart, chain[i + 1]?.start ?? line.length).trim()
    }));
}

function finishBlock(b) {
    const label = `Câu ${b.num}`;
    const n = b.options.length;
    if (n === 0) return { label, error: 'Không tìm thấy các lựa chọn A, B, C, D' };
    if (n !== 4) return { label, error: `Chỉ có ${n} lựa chọn (cần đủ 4: A, B, C, D)` };
    if (b.options.map((o) => o.letter).join('') !== 'ABCD') {
        return { label, error: 'Các lựa chọn phải theo thứ tự A, B, C, D' };
    }
    return buildItem(label, {
        stem: b.stem,
        options: b.options.map((o) => o.text),
        answerIndex: b.answer ? LETTERS.indexOf(b.answer) : null,
        explanation: b.explanation
    });
}

// Văn bản thô (từ Word/TXT) -> [{ label, raw } | { label, error }]
export function parseQuestionText(text) {
    const lines = String(text ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\u00a0/g, ' ').trim())
        .filter(Boolean);

    const blocks = [];
    let cur = null;
    let mode = 'stem'; // dòng nối tiếp thuộc về: stem | option | expl
    const begin = (num, stem) => {
        cur = { num, stem: stem.trim(), options: [], answer: null, explanation: '' };
        blocks.push(cur);
        mode = 'stem';
    };

    for (const line of lines) {
        let m = line.match(Q_START);
        if (m) {
            begin(m[1], m[2]);
            continue;
        }
        if (!cur) {
            // Đề đánh số kiểu "1. ..." không có chữ "Câu": chỉ nhận làm câu đầu tiên; mọi thứ trước đó (tiêu đề đề thi) bỏ qua
            m = line.match(NUM_START);
            if (m) begin(m[1], m[2]);
            continue;
        }

        m = line.match(ANS);
        if (m) {
            cur.answer = m[1].toUpperCase();
            mode = 'expl';
            continue;
        }
        m = line.match(EXPL);
        if (m) {
            cur.explanation = m[1].trim();
            mode = 'expl';
            continue;
        }
        const inline = splitInlineOptions(line);
        if (inline) {
            cur.options.push(...inline);
            mode = 'option';
            continue;
        }
        m = line.match(OPT_START);
        if (m) {
            cur.options.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
            mode = 'option';
            continue;
        }
        m = line.match(NUM_START);
        if (m && (cur.options.length > 0 || cur.answer)) {
            begin(m[1], m[2]);
            continue;
        }

        // Dòng nối tiếp (đề/lựa chọn/giải thích bị xuống dòng)
        if (mode === 'stem') cur.stem += ` ${line}`;
        else if (mode === 'option') cur.options[cur.options.length - 1].text += ` ${line}`;
        else cur.explanation = `${cur.explanation} ${line}`.trim();
    }

    return blocks.map(finishBlock);
}

// ---------------------------------------------------------------------------
// Excel: bảng (mảng các hàng, mỗi hàng là mảng chuỗi) -> danh sách câu
// ---------------------------------------------------------------------------
const STEM_HEADERS = ['cau hoi', 'de bai', 'noi dung', 'noi dung cau hoi', 'question'];
const ANSWER_HEADERS = ['dap an', 'dap an dung', 'answer', 'correct'];
const EXPL_HEADERS = ['giai thich', 'loi giai', 'explanation'];

// "A", "Đáp án A", "Phương án B"... -> 'A' | 'B' | ... ; không phải cột lựa chọn -> null
function optionLetterOfHeader(h) {
    const m = h.match(/^(?:dap an |phuong an |lua chon |option )?([abcd])$/);
    return m ? m[1].toUpperCase() : null;
}

// Tìm hàng tiêu đề trong 10 hàng đầu (file có thể có dòng tiêu đề đề thi phía trên)
function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
        const map = {};
        (rows[r] || []).forEach((cell, c) => {
            const h = fold(cell);
            if (!h) return;
            const letter = optionLetterOfHeader(h);
            if (letter) map[letter] ??= c;
            else if (STEM_HEADERS.includes(h)) map.stem ??= c;
            else if (ANSWER_HEADERS.includes(h)) map.answer ??= c;
            else if (EXPL_HEADERS.includes(h)) map.explanation ??= c;
        });
        if (map.stem !== undefined && map.answer !== undefined && LETTERS.every((l) => map[l] !== undefined)) {
            return { row: r, map };
        }
    }
    return null;
}

// Ô đáp án: "B", "(b)", "2" (=B) hoặc đúng nguyên văn một lựa chọn. null = để trống, -1 = không hiểu.
function answerIndexFromCell(cell, options) {
    const t = String(cell ?? '').trim();
    if (!t) return null;
    let m = t.match(/^\(?([A-Da-d])\)?[.:]?$/u);
    if (m) return LETTERS.indexOf(m[1].toUpperCase());
    m = t.match(/^[1-4]$/);
    if (m) return Number(t) - 1;
    const idx = options.findIndex((o) => fold(o) === fold(t));
    return idx;
}

export function parseQuestionRows(rows) {
    const header = findHeader(rows);
    if (!header) {
        return [
            {
                label: 'File',
                error: 'Không tìm thấy hàng tiêu đề. Cần các cột: Câu hỏi, A, B, C, D, Đáp án (hãy tải file mẫu để xem)'
            }
        ];
    }

    const { row: headerRow, map } = header;
    const items = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
        const cells = rows[r] || [];
        const get = (c) => String(cells[c] ?? '').trim();
        if (!cells.some((x) => String(x ?? '').trim())) continue; // hàng trống

        const options = LETTERS.map((l) => get(map[l]));
        items.push(
            buildItem(`Hàng ${r + 1}`, {
                stem: get(map.stem),
                options,
                answerIndex: answerIndexFromCell(get(map.answer), options),
                explanation: map.explanation === undefined ? '' : get(map.explanation)
            })
        );
    }
    if (!items.length) return [{ label: 'File', error: 'Không có câu hỏi nào bên dưới hàng tiêu đề' }];
    return items;
}

// ---------------------------------------------------------------------------
// Kiểm tra cuối: luật chung (parseQuestion), loại trùng, giới hạn số câu
// items: kết quả của parseQuestionText / parseQuestionRows. seenKeys: khóa đề đã có trong kho của người dùng.
// ---------------------------------------------------------------------------
export function finalizeImport(items, { seenKeys = [] } = {}) {
    const questions = [];
    const errors = [];
    const seen = [...seenKeys];
    let overLimit = 0;

    for (const it of items) {
        if (it.error) {
            errors.push({ where: it.label, message: it.error });
            continue;
        }
        const parsed = parseQuestion(it.raw);
        if (!parsed.ok) {
            errors.push({ where: it.label, message: REASONS[parsed.reason] || 'Câu hỏi không hợp lệ' });
            continue;
        }
        const key = stemKey(parsed.q.stem);
        if (isDuplicateStem(key, seen)) {
            errors.push({ where: it.label, message: 'Trùng với một câu đã có trong kho hoặc trong file' });
            continue;
        }
        if (questions.length >= MAX_IMPORT_QUESTIONS) {
            overLimit++;
            continue;
        }
        seen.push(key);
        questions.push({ label: it.label, q: parsed.q });
    }
    if (overLimit) {
        errors.push({ where: 'File', message: `Vượt giới hạn ${MAX_IMPORT_QUESTIONS} câu mỗi lần nhập, ${overLimit} câu cuối chưa được nhập` });
    }
    return { questions, errors };
}
