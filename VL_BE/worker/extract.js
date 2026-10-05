// Chức năng: trích văn bản từ PDF / DOCX / TXT -> danh sách trang [{ pageNumber, text }].
import { normalizeText, toVirtualPages } from './text.js';

// Lỗi do file/gói của người dùng: KHÔNG retry, hiện message cho người dùng
export class UserError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.userFacing = true;
    }
}

async function extractPdf(buffer, { maxPages, onProgress }) {
    // Import trễ để server API không phải nạp thư viện nặng khi không chạy worker
    const { getDocumentProxy } = await import('unpdf');

    let pdf;
    try {
        pdf = await getDocumentProxy(new Uint8Array(buffer));
    } catch {
        throw new UserError('Không đọc được file PDF (file hỏng hoặc có mật khẩu)', 'pdf-unreadable');
    }

    const total = pdf.numPages;
    if (total > maxPages) {
        throw new UserError(`PDF có ${total} trang, vượt giới hạn ${maxPages} trang của gói`, 'quota-pages');
    }
    await onProgress(0, total);

    const pages = [];
    for (let i = 1; i <= total; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join('');
        pages.push({ pageNumber: i, text: normalizeText(text) });
        page.cleanup();
        await onProgress(i, total);
    }
    // unpdf không chắc có destroy() (bản cũ/mới khác nhau): gọi nếu có, lỗi dọn dẹp không được làm hỏng kết quả đã trích
    try {
        if (typeof pdf.destroy === 'function') await pdf.destroy();
    } catch {
        // bỏ qua
    }

    // Toàn bộ không có chữ => PDF scan (ảnh). OCR chưa hỗ trợ ở V1.
    const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
    if (totalChars < 20) {
        throw new UserError('PDF này là ảnh scan, chưa có chữ để đọc (OCR chưa được hỗ trợ)', 'no-text');
    }
    return pages.filter((p) => p.text.length > 0);
}

async function extractDocx(buffer, { maxPages, onProgress }) {
    const mammoth = (await import('mammoth')).default;
    let value;
    try {
        ({ value } = await mammoth.extractRawText({ buffer }));
    } catch {
        throw new UserError('Không đọc được file DOCX (file hỏng)', 'docx-unreadable');
    }
    return finishVirtual(value, maxPages, onProgress);
}

async function extractTxt(buffer, { maxPages, onProgress }) {
    return finishVirtual(buffer.toString('utf8'), maxPages, onProgress);
}

// TXT/DOCX: không có trang thật nên chia "trang ảo"
async function finishVirtual(text, maxPages, onProgress) {
    const pages = toVirtualPages(text);
    if (pages.length === 0) throw new UserError('Tài liệu không có nội dung chữ', 'no-text');
    if (pages.length > maxPages) {
        throw new UserError(`Tài liệu dài ~${pages.length} trang, vượt giới hạn ${maxPages} trang của gói`, 'quota-pages');
    }
    await onProgress(pages.length, pages.length);
    return pages;
}

const EXTRACTORS = { pdf: extractPdf, docx: extractDocx, txt: extractTxt };

export async function extractPages(ext, buffer, opts) {
    const fn = EXTRACTORS[ext];
    if (!fn) throw new UserError('Định dạng file chưa được hỗ trợ', 'unsupported');
    return fn(buffer, opts);
}
