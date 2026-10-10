// Chức năng: kiểm thử bộ giới hạn lời gọi AI đồng thời (ai/concurrency.js). Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { BusyError, createLimiter } from '../ai/concurrency.js';

const tick = () => new Promise((r) => setImmediate(r));

test('không chạy quá số lượt đồng thời; lượt thừa phải chờ', async () => {
    const lim = createLimiter({ maxConcurrent: 2, maxQueue: 5, waitMs: 1000 });
    const r1 = await lim.acquire();
    const r2 = await lim.acquire();
    let third = false;
    const p3 = lim.acquire().then((r) => {
        third = true;
        return r;
    });
    await tick();
    assert.equal(third, false, 'lượt thứ 3 chưa được cấp khi còn 2 lượt đang chạy');
    assert.deepEqual(lim.stats(), { active: 2, waiting: 1 });

    r1();
    const r3 = await p3;
    assert.equal(third, true);
    assert.deepEqual(lim.stats(), { active: 2, waiting: 0 });
    r2();
    r3();
    assert.deepEqual(lim.stats(), { active: 0, waiting: 0 });
});

test('hàng chờ xử lý theo thứ tự vào trước ra trước', async () => {
    const lim = createLimiter({ maxConcurrent: 1, maxQueue: 5, waitMs: 1000 });
    const order = [];
    const first = await lim.acquire();
    const a = lim.acquire().then((r) => (order.push('a'), r));
    const b = lim.acquire().then((r) => (order.push('b'), r));
    first();
    const ra = await a;
    ra();
    const rb = await b;
    rb();
    assert.deepEqual(order, ['a', 'b']);
});

test('hàng chờ đầy thì từ chối ngay bằng BusyError', async () => {
    const lim = createLimiter({ maxConcurrent: 1, maxQueue: 1, waitMs: 1000 });
    const held = await lim.acquire();
    lim.acquire(); // vào hàng chờ (chưa có ai nhả)
    await assert.rejects(() => lim.acquire(), BusyError);
    held();
});

test('chờ quá lâu thì từ chối và rời khỏi hàng chờ', async () => {
    const lim = createLimiter({ maxConcurrent: 1, maxQueue: 5, waitMs: 20 });
    const held = await lim.acquire();
    await assert.rejects(() => lim.acquire(), BusyError);
    assert.deepEqual(lim.stats(), { active: 1, waiting: 0 });
    held();
    const again = await lim.acquire(); // slot vẫn dùng được sau khi timeout
    again();
});

test('nhả slot hai lần không làm tăng số lượt đang chạy âm', async () => {
    const lim = createLimiter({ maxConcurrent: 1, maxQueue: 5, waitMs: 1000 });
    const r = await lim.acquire();
    r();
    r();
    assert.deepEqual(lim.stats(), { active: 0, waiting: 0 });
    const r2 = await lim.acquire();
    assert.deepEqual(lim.stats(), { active: 1, waiting: 0 });
    r2();
});
