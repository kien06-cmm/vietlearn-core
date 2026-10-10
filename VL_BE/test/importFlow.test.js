// Chức năng: kiểm thử luồng NHẬP đề từ file (Excel/Word/TXT) - đọc, kiểm tra dòng lỗi, trùng, giới hạn số câu, và lỗi file.
// Phần lớn test không cần thư viện Excel (kiểm tra bằng mảng hàng và văn bản thô). Test cuối cùng cần exceljs đã cài. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMPORT_BYTES, readImportFile } from '../ai/importFile.js';
import { MAX_IMPORT_QUESTIONS, finalizeImport, parseQuestionRows, parseQuestionText } from '../ai/importRules.js';
import { stemKey } from '../ai/questionRules.js';

const HEADER = ['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án', 'Giải thích'];
const Q1 = ['Hai cộng hai bằng mấy?', '3', '4', '5', '6', 'B', '2 + 2 = 4'];
const Q2 = ['Thủ đô Việt Nam là gì?', 'Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ', 'A', ''];
const Q3 = ['Số nguyên tố nhỏ nhất là số nào?', '0', '1', '2', '4', 'C', ''];

// ---------- Đọc bảng (đường đi của Excel sau khi đã đọc ô) ----------

test('bảng hợp lệ: bỏ qua dòng tiêu đề phía trên và dòng trống, đọc đủ các câu', () => {
    const rows = [['Đề kiểm tra toán'], HEADER, Q1, ['', '', '', '', '', '', ''], Q2];
    const items = parseQuestionRows(rows);
    assert.equal(items.length, 2);
    assert.ok(items.every((it) => it.raw && !it.error), 'cả hai câu đều đọc được');
    assert.equal(items[0].raw.correct, 1, 'đáp án B -> chỉ số 1');
    assert.equal(items[1].raw.correct, 0, 'đáp án A -> chỉ số 0');
});

test('bảng không hợp lệ: từng dòng lỗi được báo riêng, không dòng nào lọt vào', () => {
    const rows = [
        HEADER,
        ['Câu thiếu đáp án', '1', '2', '3', '4', '', ''], // thiếu đáp án
        ['Câu đáp án sai', '1', '2', '3', '4', 'Z', ''], // đáp án không phải A-D và không khớp lựa chọn nào
        ['Câu thiếu lựa chọn D', '1', '2', '3', '', 'A', ''], // thiếu D
        ['', '1', '2', '3', '4', 'A', ''] // thiếu nội dung câu hỏi
    ];
    const items = parseQuestionRows(rows);
    assert.equal(items.length, 4);
    assert.ok(items.every((it) => it.error), 'mỗi dòng đều có lỗi');
    const { questions, errors } = finalizeImport(items, {});
    assert.equal(questions.length, 0);
    assert.equal(errors.length, 4);
});

test('file không có hàng tiêu đề: báo lỗi hướng dẫn tải file mẫu', () => {
    const items = parseQuestionRows([['abc', 'def'], Q1]);
    assert.equal(items.length, 1);
    assert.match(items[0].error, /hàng tiêu đề/);
});

test('có tiêu đề nhưng không có câu nào: báo lỗi', () => {
    const items = parseQuestionRows([HEADER]);
    assert.equal(items[0].label, 'File');
    assert.match(items[0].error, /Không có câu hỏi/);
});

// ---------- Kiểm tra cuối: trùng, giới hạn ----------

test('câu trùng với kho đã có bị loại; câu trùng ngay trong file cũng bị loại', () => {
    const items = parseQuestionRows([HEADER, Q1, Q2, Q2]);
    const seenKeys = [stemKey('Hai cộng hai bằng mấy?')];
    const { questions, errors } = finalizeImport(items, { seenKeys });
    assert.deepEqual(
        questions.map((q) => q.q.stem),
        ['Thủ đô Việt Nam là gì?']
    );
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => /Trùng/.test(e.message)));
});

test('vượt giới hạn số câu mỗi lần nhập: chỉ nhận đến giới hạn, báo số câu bị bỏ', () => {
    const items = parseQuestionRows([HEADER, Q1, Q2, Q3]);
    const { questions, errors } = finalizeImport(items, { maxQuestions: 2 });
    assert.equal(questions.length, 2);
    assert.ok(errors.some((e) => /Vượt giới hạn 2 câu/.test(e.message) && /1 câu/.test(e.message)));
});

test('giới hạn mặc định là 200 câu mỗi lần nhập', () => {
    assert.equal(MAX_IMPORT_QUESTIONS, 200);
});

test('bảng đủ 3 câu với giới hạn 20 (gói Free): nhận cả 3', () => {
    const { questions, errors } = finalizeImport(parseQuestionRows([HEADER, Q1, Q2, Q3]), { maxQuestions: 20 });
    assert.equal(questions.length, 3);
    assert.equal(errors.length, 0);
});

// ---------- Word / TXT ----------

test('văn bản TXT theo mẫu "Câu n:" + A-D + "Đáp án:" đọc được đầy đủ', () => {
    const text = ['Câu 1: Thủ đô của Việt Nam là gì?', 'A. Hà Nội', 'B. Huế', 'C. Đà Nẵng', 'D. Cần Thơ', 'Đáp án: A'].join('\n');
    const items = parseQuestionText(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].raw.correct, 0);
    assert.equal(items[0].raw.options.length, 4);
});

// ---------- Lỗi file (kiểm tra trước khi đọc nội dung, không cần thư viện Excel) ----------

test('file .xls (bản cũ) bị từ chối với hướng dẫn', async () => {
    await assert.rejects(() => readImportFile({ fileName: 'de.xls', buffer: Buffer.from('x') }), /bản cũ/);
});

test('định dạng khác (.pdf) bị từ chối', async () => {
    await assert.rejects(() => readImportFile({ fileName: 'de.pdf', buffer: Buffer.from('%PDF') }), /Chỉ hỗ trợ file/);
});

test('file rỗng bị từ chối', async () => {
    await assert.rejects(() => readImportFile({ fileName: 'de.txt', buffer: Buffer.alloc(0) }), /File rỗng/);
});

test('file quá lớn (trên 2 MB) bị từ chối trước khi đọc', async () => {
    await assert.rejects(() => readImportFile({ fileName: 'de.xlsx', buffer: Buffer.alloc(MAX_IMPORT_BYTES + 1) }), /quá lớn/);
});

test('file .xlsx không phải dạng zip (hỏng hoặc bị đổi đuôi) bị từ chối', async () => {
    await assert.rejects(() => readImportFile({ fileName: 'de.xlsx', buffer: Buffer.from('hello world') }), /không đúng định dạng/);
});

test('file TXT hợp lệ đi qua được readImportFile', async () => {
    const text = 'Câu 1: Thủ đô của Việt Nam là gì?\nA. Hà Nội\nB. Huế\nC. Đà Nẵng\nD. Cần Thơ\nĐáp án: A';
    const items = await readImportFile({ fileName: 'de.txt', buffer: Buffer.from(text, 'utf8') });
    assert.equal(items.length, 1);
    assert.ok(items[0].raw);
});

// ---------- Luồng đầy đủ với file Excel thật (cần exceljs đã cài) ----------

test('file Excel tải về từ mẫu có thể nhập lại, không cần AI', async () => {
    const { buildSample } = await import('../ai/importSamples.js');
    const sample = await buildSample('xlsx');
    const items = await readImportFile({ fileName: sample.fileName, buffer: sample.buffer });
    const { questions } = finalizeImport(items, { maxQuestions: 20 });
    assert.ok(questions.length > 0, 'file mẫu phải nhập được ít nhất một câu');
});

test('Excel tự tạo: hàng sai và hàng đúng được tách đúng qua readImportFile', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('De');
    ws.addRow(HEADER);
    ws.addRow(Q1);
    ws.addRow(['Câu thiếu đáp án', '1', '2', '3', '4', '', '']);
    const buffer = await wb.xlsx.writeBuffer();

    const items = await readImportFile({ fileName: 'de.xlsx', buffer: Buffer.from(buffer) });
    const { questions, errors } = finalizeImport(items, {});
    assert.equal(questions.length, 1);
    assert.equal(questions[0].q.correct, 1);
    assert.equal(errors.length, 1);
});
