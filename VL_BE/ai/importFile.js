// Chức năng: đọc file đề trắc nghiệm người dùng gửi lên (.xlsx / .docx / .txt) -> danh sách câu thô cho importRules.finalizeImport.
// Không gọi AI. Thư viện nặng (mammoth, exceljs) được nạp trễ để server API không tốn bộ nhớ khi không có ai nhập đề.
import { parseQuestionRows, parseQuestionText } from './importRules.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // file đề tối đa 2 MB
const MAX_SHEET_ROWS = 2000;

// Lỗi do file của người dùng (sai định dạng, hỏng...): trả 400 kèm message tiếng Việt
export class ImportFileError extends Error {}

const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK": .docx và .xlsx đều là file zip

async function readDocx(buffer) {
    const mammoth = (await import('mammoth')).default;
    try {
        const { value } = await mammoth.extractRawText({ buffer });
        return parseQuestionText(value);
    } catch {
        throw new ImportFileError('Không đọc được file Word (file hỏng hoặc có mật khẩu)');
    }
}

async function readXlsx(buffer) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch {
        throw new ImportFileError('Không đọc được file Excel (file hỏng hoặc có mật khẩu)');
    }

    const ws = wb.worksheets[0]; // chỉ đọc sheet đầu tiên
    if (!ws) throw new ImportFileError('File Excel không có trang tính nào');

    const lastRow = Math.min(ws.rowCount, MAX_SHEET_ROWS);
    const lastCol = Math.min(ws.columnCount, 30);
    const rows = [];
    for (let r = 1; r <= lastRow; r++) {
        const row = ws.getRow(r);
        const cells = [];
        for (let c = 1; c <= lastCol; c++) cells.push(String(row.getCell(c).text ?? '').trim());
        rows.push(cells);
    }
    return parseQuestionRows(rows);
}

// Trả [{ label, raw } | { label, error }]. Ném ImportFileError nếu file không dùng được.
export async function readImportFile({ fileName, buffer }) {
    const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

    if (ext === 'doc' || ext === 'xls') {
        throw new ImportFileError('File .doc/.xls (bản cũ) chưa hỗ trợ. Hãy mở bằng Word/Excel rồi Lưu thành .docx/.xlsx');
    }
    if (!['xlsx', 'docx', 'txt'].includes(ext)) throw new ImportFileError('Chỉ hỗ trợ file .xlsx, .docx hoặc .txt');
    if (!buffer.length) throw new ImportFileError('File rỗng');
    if (buffer.length > MAX_IMPORT_BYTES) throw new ImportFileError('File quá lớn (tối đa 2 MB)');
    if (ext !== 'txt' && !isZip(buffer)) throw new ImportFileError('File không đúng định dạng (file hỏng hoặc bị đổi đuôi)');

    if (ext === 'docx') return readDocx(buffer);
    if (ext === 'xlsx') return readXlsx(buffer);
    return parseQuestionText(buffer.toString('utf8'));
}
