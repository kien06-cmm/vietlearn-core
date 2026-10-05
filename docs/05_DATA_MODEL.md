# 05_DATA_MODEL — Mô hình dữ liệu Firestore (VietLearn V1)

> Bản nháp theo 13_V1_ROADMAP. Phase 1 chi tiết; các phase sau chỉ phác thảo, chốt khi tới phase đó.

## Nguyên tắc

1. Firestore chặn mọi truy cập từ client. Chỉ backend (Admin SDK) đọc/ghi. File tài liệu nằm ở Supabase Storage (bucket riêng tư), cũng chỉ backend truy cập.
2. **Đáp án đúng tách riêng** khỏi câu hỏi hiển thị cho người làm bài (collection `answerKeys`, chỉ backend đọc).
3. Thiết kế theo truy vấn: lưu sẵn số liệu tổng hợp (denormalize) để giảm lượt đọc, vì Firestore tính phí theo lượt đọc/ghi.
4. Mọi tài liệu có `createdAt`, `updatedAt` (timestamp do server đặt).
5. Quiz đã publish là **bất biến**: sửa bài đã có người làm thì tạo version mới.
6. Tên collection dùng tiếng Anh, camelCase cho field.

## Phase 1 — Nền tảng

### `users/{uid}`  (uid = Firebase Auth uid)
| Field | Kiểu | Ghi chú |
|---|---|---|
| email | string | |
| displayName | string | |
| plan | string | `free` mặc định. Admin đổi tay ở V1 |
| isAdmin | boolean | Cân nhắc dùng custom claim thay vì field |
| settings | map | giao diện (dark mode, cỡ chữ) |
| createdAt, updatedAt | timestamp | |
| deletedAt | timestamp? | xóa mềm khi người dùng xóa tài khoản |

### `guestSessions/{sessionId}`
| Field | Kiểu | Ghi chú |
|---|---|---|
| displayName | string | tên hiển thị khi vào phòng |
| roomId | string | |
| expiresAt | timestamp | token tạm hết hạn |
| claimedByUid | string? | khi khách tạo tài khoản để lưu kết quả |

### `analyticsEvents/{eventId}`
`type` (`visit`, `register`...), `uid?`, `at`, `meta`.

## Phase 2 — Tài liệu

### `documents/{docId}`
`ownerId`, `name`, `mimeType`, `ext`, `sizeBytes`, `storagePath` (`{ownerId}/{docId}/original.{ext}` trong bucket Supabase `documents`), `status` (`uploading` → `queued` → `processing` → `ready` | `failed`), `pageCount?`, `folder`, `tags[]` (tối đa 10), `pinned`, `error?`, `createdAt`, `updatedAt`.

### `documents/{docId}/chunks/{chunkId}`
`pageNumber`, `index`, `text`. Lưu subcollection vì Phase 3 luôn đọc chunk theo từng tài liệu.

### `jobs/{jobId}`
Hàng đợi dựa trên Firestore (không dùng Redis ở V1).
`type` (`extract_document`), `ownerId`, `documentId`, `status` (`queued` → `running` → `done` | `failed`), `attempts`, `maxAttempts` (3), `progress` (`{ done, total }`, ví dụ 35/50 trang), `error?`, `deadLetter` (boolean), `runAfter` (phục vụ retry có backoff), `createdAt`, `updatedAt`.

### Hạn mức và tìm kiếm
- Hạn mức theo gói: `VL_BE/config/plans.js` (dung lượng file, số tài liệu, số trang).
- Tìm kiếm V1 chỉ theo tên, tag, thư mục. Tìm trong nội dung chunk dời sau V1.

## Phase 3 — AI và Question Bank (phác thảo)

### `creditLedger/{entryId}`
`uid`, `kind` (`estimated` | `reserved` | `actual` | `refund`), `amount`, `jobId`, `at`. Kiểm tra quota trước khi gọi AI; job lỗi phải hoàn credit.

### `topics/{topicId}`
`subject`, `chapter`, `name`. Hệ thống: Môn → Chương → Chủ đề.

### `questions/{questionId}`
`ownerId`, `topicId` (**bắt buộc**), `type` (4 lựa chọn | nhiều đáp án | đúng/sai | điền khuyết | trả lời ngắn), `stem`, `options[]`, `explanation?`, `source` = `{documentId, pageNumber, chunkId}`, `reviewStatus` (`draft` | `approved`), `createdAt`.

### `answerKeys/{questionId}`
`correct` (giá trị đáp án đúng). **Chỉ backend đọc.**

## Phase 4 — Quiz, Phòng, Làm bài (phác thảo)

- `quizzes/{quizId}` và `quizzes/{quizId}/versions/{versionId}` (bất biến sau publish; hỗ trợ fork).
- `rooms/{roomId}`: `quizVersionId`, `hostId`, `code`, `status` (`WAITING` → `RUNNING` → `ENDED`), `maxParticipants`. Trạng thái do server quyết định.
- `attempts/{attemptId}`: `roomId?`, `quizVersionId`, `participant` (uid hoặc guest), `seed` (random phía server), `answers`, `startedAt`, `submittedAt`, `score`, `events[]` (tab visibility, ...).

## Phase 5 — Vòng lặp học tập (phác thảo)

- `mistakes/{id}`: `uid`, `questionId`, `errorType` (gợi ý, không khẳng định), `confidence`, `chosenWrongOption`.
- `reviewSchedule/{id}`: `uid`, `questionId`, `nextReviewAt` (lịch ôn 1 → 3 → 7 ngày, điều chỉnh theo đúng/sai và mức tự tin).
- `topicMastery/{uid_topicId}`: số liệu tổng hợp sẵn theo chủ đề.
- `roomStats/{roomId}`: số liệu heatmap, chỉ hiển thị khi đủ 5 lượt.

## Quyết định cần chốt

- [ ] Admin: dùng custom claim hay field `isAdmin`?
- [ ] Biến `DATABASE_URL` trên Render có liên quan Postgres không? Nếu có thì quyết định có dùng Postgres cho thống kê (heatmap, topic mastery) hay không. Nên chốt trước Phase 4-5.
- [x] Chunk tài liệu: subcollection `documents/{docId}/chunks`.
- [x] Hàng đợi: Firestore collection `jobs` (đổi sang Redis nếu tải lớn).
- [ ] Dọn tài liệu kẹt ở `uploading` (người dùng không bấm xác nhận): làm ở Lát 2 hoặc cuối Phase 2.
- [ ] Danh sách chỉ mục (index) tổng hợp, bổ sung khi viết truy vấn thật.
