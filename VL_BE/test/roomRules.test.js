// Chức năng: kiểm thử luật phòng làm bài (không gọi mạng/DB): mã phòng, chuyển trạng thái, hết hạn. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CODE_ALPHABET,
    CODE_LENGTH,
    ROOM_STATUS,
    canTransition,
    effectiveStatus,
    generateCode,
    isRoomEnded,
    normalizeCode,
    participantKey
} from '../quiz/roomRules.js';

test('mã phòng đúng độ dài và chỉ dùng ký tự không dễ nhầm', () => {
    for (let i = 0; i < 200; i++) {
        const code = generateCode();
        assert.equal(code.length, CODE_LENGTH);
        assert.ok([...code].every((c) => CODE_ALPHABET.includes(c)));
    }
    assert.ok(!/[ILO01]/.test(CODE_ALPHABET));
});

test('chuẩn hóa mã người dùng gõ', () => {
    assert.equal(normalizeCode('abc xyz'), 'ABCXYZ');
    assert.equal(normalizeCode(' ab-cd 23 '), 'ABCD23');
    assert.equal(normalizeCode('ABC12'), null); // thiếu ký tự
    assert.equal(normalizeCode('ABCDE0'), null); // có ký tự không thuộc bảng mã
    assert.equal(normalizeCode(123456), null);
    assert.equal(normalizeCode(null), null);
});

test('chuyển trạng thái chỉ đi một chiều', () => {
    assert.ok(canTransition('WAITING', 'RUNNING'));
    assert.ok(canTransition('WAITING', 'ENDED'));
    assert.ok(canTransition('RUNNING', 'ENDED'));
    assert.ok(!canTransition('RUNNING', 'WAITING'));
    assert.ok(!canTransition('ENDED', 'RUNNING'));
    assert.ok(!canTransition('WAITING', 'WAITING'));
});

test('phòng quá hạn coi như đã kết thúc, kể cả chưa ai bấm kết thúc', () => {
    const now = 1_000_000;
    assert.equal(effectiveStatus({ status: 'RUNNING', expiresAt: now + 1000 }, now), ROOM_STATUS.RUNNING);
    assert.equal(effectiveStatus({ status: 'RUNNING', expiresAt: now - 1 }, now), ROOM_STATUS.ENDED);
    assert.equal(effectiveStatus({ status: 'WAITING', expiresAt: new Date(now - 5) }, now), ROOM_STATUS.ENDED);
    assert.equal(effectiveStatus({ status: 'WAITING', expiresAt: { toMillis: () => now + 5 } }, now), ROOM_STATUS.WAITING);
    assert.ok(isRoomEnded(null, now));
});

test('khóa người tham gia gồm loại và id', () => {
    assert.equal(participantKey({ type: 'guest', id: 'g_1' }), 'guest_g_1');
    assert.equal(participantKey({ type: 'user', id: 'abc' }), 'user_abc');
});
