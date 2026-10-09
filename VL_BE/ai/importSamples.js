// Chức năng: tạo file MẪU để giáo viên tải về rồi điền đề của mình (.xlsx và .docx). File mẫu được dựng bằng code từ cùng một danh sách câu,
// nên luôn khớp với luật đọc ở ai/importRules.js (có test đọc lại chính file mẫu). Không gọi AI, không đọc/ghi DB.
// Thư viện nặng (exceljs, jszip) được nạp trễ giống importFile.js.

export const SAMPLE_QUESTIONS = [
    {
        stem: 'Thủ đô của Việt Nam là thành phố nào?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ'],
        answer: 'A',
        explanation: 'Hà Nội là thủ đô của nước ta.'
    },
    {
        stem: 'Nghiệm của phương trình $2x + 6 = 0$ là bao nhiêu?',
        options: ['$x = 3$', '$x = -3$', '$x = 6$', '$x = -6$'],
        answer: 'B',
        explanation: 'Ta có $2x = -6$ nên $x = -3$.'
    },
    {
        stem: 'Ở áp suất tiêu chuẩn, nước nguyên chất sôi ở bao nhiêu độ C?',
        options: ['50', '90', '100', '120'],
        answer: 'C',
        explanation: ''
    }
];

const FILE_BASE = 'mau-nhap-de';

const SAMPLE_META = {
    xlsx: {
        fileName: `${FILE_BASE}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    docx: {
        fileName: `${FILE_BASE}.docx`,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }
};

export const SAMPLE_FORMATS = Object.keys(SAMPLE_META);

// ---------------------------------------------------------------------------
// Excel: sheet đầu là bảng đề mẫu (parser chỉ đọc sheet đầu), sheet thứ hai là hướng dẫn ngắn
// ---------------------------------------------------------------------------
async function buildXlsx() {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();

    const ws = wb.addWorksheet('Đề mẫu');
    ws.columns = [
        { header: 'Câu hỏi', width: 50 },
        { header: 'A', width: 22 },
        { header: 'B', width: 22 },
        { header: 'C', width: 22 },
        { header: 'D', width: 22 },
        { header: 'Đáp án', width: 10 },
        { header: 'Giải thích', width: 40 }
    ];
    for (const q of SAMPLE_QUESTIONS) ws.addRow([q.stem, ...q.options, q.answer, q.explanation]);

    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1769E0' } };
    head.alignment = { vertical: 'middle' };
    ws.eachRow((row) => {
        row.alignment = { ...row.alignment, wrapText: true, vertical: 'top' };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const guide = wb.addWorksheet('Hướng dẫn');
    guide.getColumn(1).width = 90;
    [
        'CÁCH ĐIỀN FILE MẪU',
        'Xóa 3 dòng mẫu ở trang "Đề mẫu", rồi điền đề của bạn từ dòng 2 trở xuống. KHÔNG đổi tên các cột ở dòng 1.',
        'Mỗi dòng là một câu hỏi gồm đủ 4 lựa chọn A, B, C, D và đúng 1 đáp án.',
        'Cột "Đáp án" chỉ ghi một chữ: A, B, C hoặc D. Cột "Giải thích" có thể để trống.',
        'Công thức toán, lý, hóa viết trong dấu đô la, ví dụ: $x^2 + 2x + 1 = 0$.',
        'Mỗi lần nhập tối đa 20 câu (gói Free) hoặc 200 câu (gói Pro), file tối đa 2 MB. Hệ thống chỉ đọc trang đầu tiên.'
    ].forEach((line, i) => {
        const row = guide.addRow([line]);
        row.alignment = { wrapText: true, vertical: 'top' };
        if (i === 0) row.font = { bold: true };
    });

    return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Word: .docx tối giản (3 phần bắt buộc của gói OOXML) chứa các đoạn văn theo đúng cú pháp "Câu 1. ... A. ... Đáp án: B"
// ---------------------------------------------------------------------------
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const paragraph = (text, { bold = false } = {}) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

// Danh sách dòng của đề mẫu. Dòng tiêu đề/lưu ý đặt TRƯỚC "Câu 1." nên parser bỏ qua; dòng lưu ý không bắt đầu bằng số.
function docxParagraphs() {
    const out = [
        paragraph('ĐỀ MẪU NHẬP VÀO VIETLEARN', { bold: true }),
        paragraph('Lưu ý: xóa các dòng lưu ý này và 3 câu mẫu, rồi dán đề của bạn vào theo đúng kiểu bên dưới.'),
        paragraph('Mỗi câu gồm: dòng "Câu N." + đề bài, bốn lựa chọn A, B, C, D (mỗi lựa chọn một dòng), dòng "Đáp án:" ghi một chữ cái, dòng "Giải thích:" là tùy chọn.'),
        paragraph('')
    ];
    SAMPLE_QUESTIONS.forEach((q, i) => {
        out.push(paragraph(`Câu ${i + 1}. ${q.stem}`));
        q.options.forEach((opt, j) => out.push(paragraph(`${'ABCD'[j]}. ${opt}`)));
        out.push(paragraph(`Đáp án: ${q.answer}`));
        if (q.explanation) out.push(paragraph(`Giải thích: ${q.explanation}`));
        out.push(paragraph(''));
    });
    return out;
}

async function buildDocx() {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

    zip.file(
        '[Content_Types].xml',
        `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
            '</Types>'
    );
    zip.file(
        '_rels/.rels',
        `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
            '</Relationships>'
    );
    zip.file(
        'word/document.xml',
        `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docxParagraphs().join('')}</w:body></w:document>`
    );

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// format: 'xlsx' | 'docx' -> { buffer, fileName, contentType }. Ném lỗi nếu format lạ (route đã chặn trước).
export async function buildSample(format) {
    const meta = SAMPLE_META[format];
    if (!meta) throw new Error(`Không có file mẫu định dạng ${format}`);
    const buffer = format === 'xlsx' ? await buildXlsx() : await buildDocx();
    return { buffer, ...meta };
}
