// Chức năng: chuẩn hóa văn bản, chia "trang ảo" (cho TXT/DOCX) và chia chunk (hàm thuần, dễ test).

const VIRTUAL_PAGE_CHARS = 3000; // TXT/DOCX không có trang thật: ~3000 ký tự = 1 trang ảo
const CHUNK_MAX_CHARS = 1200;

// Chuẩn hóa: NFC (quan trọng với tiếng Việt: dấu dựng sẵn), bỏ ký tự điều khiển, gọn khoảng trắng
export function normalizeText(input) {
    return String(input ?? '')
        .normalize('NFC')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/[ \t\u00A0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Cắt một đoạn quá dài thành các mảnh <= max ký tự (ưu tiên cắt ở khoảng trắng)
function hardSplit(text, max) {
    const out = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

// Gom các đoạn thành các khối <= max ký tự
export function splitByLength(text, max) {
    const paragraphs = normalizeText(text)
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);

    const blocks = [];
    let current = '';
    for (const p of paragraphs) {
        const parts = p.length > max ? hardSplit(p, max) : [p];
        for (const part of parts) {
            if (current && current.length + part.length + 1 > max) {
                blocks.push(current);
                current = part;
            } else {
                current = current ? `${current}\n${part}` : part;
            }
        }
    }
    if (current) blocks.push(current);
    return blocks;
}

// Văn bản liền mạch -> danh sách trang ảo [{ pageNumber, text }]
export function toVirtualPages(text) {
    return splitByLength(text, VIRTUAL_PAGE_CHARS).map((t, i) => ({ pageNumber: i + 1, text: t }));
}

// Trang -> chunk [{ id, pageNumber, index, text }]. id cố định => chạy lại job không tạo chunk trùng.
export function buildChunks(pages) {
    const chunks = [];
    for (const page of pages) {
        splitByLength(page.text, CHUNK_MAX_CHARS).forEach((text, index) => {
            chunks.push({
                id: `p${String(page.pageNumber).padStart(4, '0')}_${String(index).padStart(3, '0')}`,
                pageNumber: page.pageNumber,
                index,
                text
            });
        });
    }
    return chunks;
}
