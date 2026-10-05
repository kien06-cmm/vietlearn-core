// Chức năng: test các hàm thuần chuẩn hóa / chia trang ảo / chia chunk của worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, toVirtualPages, buildChunks, splitByLength } from '../worker/text.js';

test('normalizeText: đưa tiếng Việt về NFC và gọn khoảng trắng', () => {
    const decomposed = 'Tiê\u0301ng Việt'; // "ế" dạng tổ hợp
    const out = normalizeText(`  ${decomposed}  \r\n\r\n\r\n\r\nxin   chào\u0000 `);
    assert.equal(out, 'Tiếng Việt\n\nxin chào');
});

test('splitByLength: không khối nào vượt giới hạn, kể cả đoạn rất dài', () => {
    const long = 'từ '.repeat(2000);
    const blocks = splitByLength(long, 500);
    assert.ok(blocks.length > 1);
    for (const b of blocks) assert.ok(b.length <= 500);
});

test('toVirtualPages: đánh số trang liên tục từ 1', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Dòng số ${i} có nội dung tiếng Việt`).join('\n');
    const pages = toVirtualPages(text);
    assert.ok(pages.length >= 2);
    pages.forEach((p, i) => assert.equal(p.pageNumber, i + 1));
});

test('buildChunks: id cố định, giữ đúng số trang', () => {
    const pages = [
        { pageNumber: 1, text: 'Đoạn một.' },
        { pageNumber: 35, text: 'Đoạn hai.' }
    ];
    const chunks = buildChunks(pages);
    assert.deepEqual(
        chunks.map((c) => [c.id, c.pageNumber]),
        [
            ['p0001_000', 1],
            ['p0035_000', 35]
        ]
    );
});
