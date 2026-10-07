// Chức năng: kiểm thử luật nhập đề có sẵn (ai/importRules.js) - đọc đề Word/TXT, đọc bảng Excel, báo lỗi từng câu, loại trùng. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeImport, parseQuestionRows, parseQuestionText } from '../ai/importRules.js';
import { stemKey } from '../ai/questionRules.js';

const SAMPLE = `ĐỀ KIỂM TRA 15 PHÚT
Câu 1. Thủ đô của Việt Nam là thành phố nào?
A. Hà Nội
B. Huế
C. Đà Nẵng
D. Cần Thơ
Đáp án: A
Giải thích: Hà Nội là thủ đô của nước ta.
Câu 2: Một cộng một bằng mấy trong hệ thập phân?
A. 1 B. 2 C. 3 D. 4
Đáp án: B
`;

test('đọc đề Word: bỏ tiêu đề, nhận đủ 2 câu, đáp án và giải thích đúng', () => {
    const items = parseQuestionText(SAMPLE);
    assert.equal(items.length, 2);
    assert.equal(items[0].raw.correct, 0);
    assert.equal(items[0].raw.options[1], 'Huế');
    assert.equal(items[0].raw.explanation, 'Hà Nội là thủ đô của nước ta.');

    const { questions, errors } = finalizeImport(items);
    assert.equal(questions.length, 2);
    assert.equal(errors.length, 0);
});

test('đọc đề Word: 4 lựa chọn trên cùng một dòng được tách đúng', () => {
    const items = parseQuestionText(SAMPLE);
    assert.deepEqual(items[1].raw.options, ['1', '2', '3', '4']);
    assert.equal(items[1].raw.correct, 1);
});

test('đọc đề Word: đề bị xuống dòng vẫn được nối lại', () => {
    const items = parseQuestionText(`Câu 1. Thủ đô của Việt Nam
là thành phố nào?
A. Hà
Nội
B. Huế
C. Đà Nẵng
D. Cần Thơ
Đáp án: A`);
    assert.equal(items[0].raw.stem, 'Thủ đô của Việt Nam là thành phố nào?');
    assert.equal(items[0].raw.options[0], 'Hà Nội');
});

test('đọc đề Word: thiếu đáp án thì báo lỗi, không đoán', () => {
    const items = parseQuestionText(`Câu 1. Thủ đô của Việt Nam là thành phố nào?
A. Hà Nội
B. Huế
C. Đà Nẵng
D. Cần Thơ`);
    assert.equal(items.length, 1);
    assert.match(items[0].error, /đáp án/i);
});

test('đọc đề Word: chỉ có 3 lựa chọn thì báo lỗi rõ số lượng', () => {
    const items = parseQuestionText(`Câu 3. Thủ đô của Việt Nam là thành phố nào?
A. Hà Nội
B. Huế
C. Đà Nẵng
Đáp án: A`);
    assert.equal(items[0].label, 'Câu 3');
    assert.match(items[0].error, /Chỉ có 3 lựa chọn/);
});

test('"Đáp án: Bình Dương..." không bị đọc nhầm thành đáp án B', () => {
    const items = parseQuestionText(`Câu 1. Tỉnh nào sau đây thuộc Đông Nam Bộ?
A. Bình Dương
B. Huế
C. Đà Nẵng
D. Cần Thơ
Đáp án: Bình Dương`);
    assert.match(items[0].error, /đáp án/i);
});

test('đề đánh số kiểu "1." không có chữ Câu vẫn đọc được', () => {
    const items = parseQuestionText(`1. Thủ đô của Việt Nam là thành phố nào?
A. Hà Nội
B. Huế
C. Đà Nẵng
D. Cần Thơ
Đáp án: A
2. Sông nào dài nhất Việt Nam hiện nay?
A. Sông Hồng
B. Sông Mê Kông
C. Sông Đà
D. Sông Cả
Đáp án: B`);
    assert.equal(items.length, 2);
    assert.equal(items[1].raw.correct, 1);
});

const HEADER = ['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án', 'Giải thích'];

test('đọc Excel: tìm hàng tiêu đề dù có dòng tiêu đề đề thi phía trên, nhận đáp án chữ thường', () => {
    const rows = [
        ['Danh sách đề'],
        HEADER,
        ['Thủ đô của Việt Nam là gì?', 'Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ', 'a', 'Vì lịch sử'],
        [],
        ['Câu thiếu lựa chọn dài đủ', 'x', 'y', '', 'z', 'B', ''],
        ['Câu sai đáp án đủ dài ký tự', '1', '2', '3', '4', 'E', '']
    ];
    const items = parseQuestionRows(rows);
    assert.equal(items.length, 3); // hàng trống bị bỏ qua
    assert.equal(items[0].label, 'Hàng 3');
    assert.equal(items[0].raw.correct, 0);
    assert.equal(items[1].label, 'Hàng 5');
    assert.match(items[1].error, /Thiếu lựa chọn C/);
    assert.match(items[2].error, /Đáp án không hợp lệ/);
});

test('đọc Excel: thiếu hàng tiêu đề thì báo cách khắc phục', () => {
    const items = parseQuestionRows([['a', 'b']]);
    assert.equal(items.length, 1);
    assert.match(items[0].error, /tiêu đề/);
});

test('loại câu trùng trong file và trùng với kho đã có', () => {
    const rows = [
        HEADER,
        ['Thủ đô của Việt Nam là gì?', 'Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ', 'A', ''],
        ['Thủ đô của Việt Nam là gì?', 'Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ', 'A', '']
    ];
    const first = finalizeImport(parseQuestionRows(rows));
    assert.equal(first.questions.length, 1);
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0].message, /Trùng/);

    const again = finalizeImport(parseQuestionRows(rows.slice(0, 2)), { seenKeys: [stemKey('Thủ đô của Việt Nam là gì?')] });
    assert.equal(again.questions.length, 0);
});

test('câu quá ngắn bị luật chung từ chối kèm lý do dễ hiểu', () => {
    const items = parseQuestionRows([HEADER, ['Ngắn', 'a', 'b', 'c', 'd', 'A', '']]);
    const { questions, errors } = finalizeImport(items);
    assert.equal(questions.length, 0);
    assert.match(errors[0].message, /10-500 ký tự/);
});
