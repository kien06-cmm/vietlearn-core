// Chức năng: kiểm thử trích văn bản (TXT), trang ảo, giới hạn số trang của gói, định dạng không hỗ trợ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPages, UserError } from '../worker/extract.js';

const noop = async () => {};

test('TXT tiếng Việt: giữ nguyên dấu, trang bắt đầu từ 1', async () => {
    const buf = Buffer.from('Đây là bài học về phương trình bậc hai.\n\nNghiệm của phương trình là x = 1.', 'utf8');
    const pages = await extractPages('txt', buf, { maxPages: 10, onProgress: noop });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].pageNumber, 1);
    assert.ok(pages[0].text.includes('phương trình bậc hai'));
});

test('TXT dài được chia thành nhiều trang ảo, có báo tiến độ cuối', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `Dòng số ${i + 1} của tài liệu thử nghiệm.`).join('\n');
    let last = null;
    const pages = await extractPages('txt', Buffer.from(text, 'utf8'), {
        maxPages: 100,
        onProgress: async (done, total) => {
            last = { done, total };
        }
    });
    assert.ok(pages.length > 1);
    assert.deepEqual(last, { done: pages.length, total: pages.length });
});

test('Vượt giới hạn trang của gói => UserError quota-pages (không retry)', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `Dòng số ${i + 1} của tài liệu thử nghiệm.`).join('\n');
    await assert.rejects(
        () => extractPages('txt', Buffer.from(text, 'utf8'), { maxPages: 1, onProgress: noop }),
        (err) => err instanceof UserError && err.code === 'quota-pages'
    );
});

test('TXT rỗng => UserError no-text', async () => {
    await assert.rejects(
        () => extractPages('txt', Buffer.from('   \n  ', 'utf8'), { maxPages: 10, onProgress: noop }),
        (err) => err instanceof UserError && err.code === 'no-text'
    );
});

test('Định dạng chưa hỗ trợ => UserError unsupported', async () => {
    await assert.rejects(
        () => extractPages('pptx', Buffer.from('x'), { maxPages: 10, onProgress: noop }),
        (err) => err instanceof UserError && err.code === 'unsupported'
    );
});
