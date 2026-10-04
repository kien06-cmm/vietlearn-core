// Chức năng: kiểm thử phân quyền cơ bản (người A không đọc được dữ liệu người B). Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRole, ownerRoles } from '../middleware/permissions.js';

function fakeRes() {
    return {
        code: null,
        body: null,
        status(c) {
            this.code = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        }
    };
}

// Chạy middleware, trả về { passed, res }
async function run(mw, req) {
    const res = fakeRes();
    let passed = false;
    await mw(req, res, () => {
        passed = true;
    });
    return { passed, res };
}

const ownerCheck = checkRole(['owner', 'admin'], ownerRoles((req) => req.params.uid));

const userA = { actor: { type: 'user', id: 'uidA' }, profile: { isAdmin: false } };

test('chủ resource đọc được dữ liệu của mình', async () => {
    const { passed } = await run(ownerCheck, { ...userA, params: { uid: 'uidA' } });
    assert.equal(passed, true);
});

test('người A KHÔNG đọc được dữ liệu người B', async () => {
    const { passed, res } = await run(ownerCheck, { ...userA, params: { uid: 'uidB' } });
    assert.equal(passed, false);
    assert.equal(res.code, 403);
});

test('admin đọc được dữ liệu người khác', async () => {
    const admin = { actor: { type: 'user', id: 'uidAdmin' }, profile: { isAdmin: true } };
    const { passed } = await run(ownerCheck, { ...admin, params: { uid: 'uidB' } });
    assert.equal(passed, true);
});

test('khách không phải owner của bất kỳ resource nào', async () => {
    const guest = { actor: { type: 'guest', id: 'g_123' }, params: { uid: 'g_123' } };
    const { passed, res } = await run(ownerCheck, guest);
    assert.equal(passed, false);
    assert.equal(res.code, 403);
});

test('vai trò theo ngữ cảnh: host qua, participant bị chặn ở route chỉ cho host', async () => {
    const hostOnly = (roles) => checkRole(['host'], async () => roles);

    const asHost = await run(hostOnly(['host']), { ...userA });
    assert.equal(asHost.passed, true);

    const asParticipant = await run(hostOnly(['participant']), { ...userA });
    assert.equal(asParticipant.passed, false);
    assert.equal(asParticipant.res.code, 403);
});

test('route chỉ cho khách (role guest)', async () => {
    const guestOnly = checkRole(['guest']);

    const asGuest = await run(guestOnly, { actor: { type: 'guest', id: 'g_1' } });
    assert.equal(asGuest.passed, true);

    const asUser = await run(guestOnly, { ...userA });
    assert.equal(asUser.passed, false);
});

test('isAdmin phải đúng là true (chuỗi "true" không được tính)', async () => {
    const fake = { actor: { type: 'user', id: 'uidX' }, profile: { isAdmin: 'true' } };
    const { passed } = await run(checkRole(['admin']), fake);
    assert.equal(passed, false);
});
