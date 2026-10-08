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
- Tìm kiếm V1 chỉ theo tên, tag, thư mục (frontend lọc trên danh sách đã tải, tối đa 200 tài liệu). Tìm trong nội dung chunk dời sau V1.
- Xem lại từng trang: `GET /documents/:id/pages/:page` (đọc chunk theo `pageNumber`, chỉ khi `status = ready`). TXT/DOCX là "trang ảo" (~3000 ký tự).

## Phase 3 — AI và Question Bank (phác thảo)

### `creditLedger/{entryId}`
`uid`, `kind` (`estimated` | `reserved` | `actual` | `refund`), `amount`, `jobId`, `at`. Kiểm tra quota trước khi gọi AI; job lỗi phải hoàn credit.

### `topics/{topicId}`
`ownerId`, `subject`, `chapter`, `name`. Hệ thống: Môn → Chương → Chủ đề. API: `GET/POST /topics` (tạo trùng thì trả chủ đề cũ).

### `questions/{questionId}`
`ownerId`, `topicId` (**bắt buộc**), `type` (4 lựa chọn | nhiều đáp án | đúng/sai | điền khuyết | trả lời ngắn), `stem`, `options[]`, `explanation?`, `source` = `{documentId, pageNumber, chunkId}`, `reviewStatus` (`draft` | `approved`), `createdAt`.

### `answerKeys/{questionId}`
`correct` (giá trị đáp án đúng), `alternatives?` (điền khuyết). **Chỉ backend đọc.**

### Job `generate_questions` (cùng collection `jobs`)
`type`, `ownerId`, `documentId`, `topicId`, `count`, `types[]`, `pageFrom?`, `pageTo?`, `credits` = `{period, reserved}`, `result` = `{requested, generated, saved, rejected, inputTokens, outputTokens}`.
Credits: `creditBalances/{uid}_{YYYY-MM}` (`used`, `reserved`) + sổ cái `creditLedger/{jobId}_{reserved|actual|refund}`. 1 credit = 1 câu hỏi.

### API Phase 3
`GET /questions/credits` · `POST /questions/generate` (202, giữ chỗ credits) · `GET /questions/jobs/:jobId` · `GET /questions?topicId&documentId&jobId&reviewStatus` · `GET/PATCH/DELETE /questions/:id` · `GET /questions/:id/source` (nút "Xem nguồn") · `POST /questions/:id/approve` · `POST /questions/approve-many`.
Sửa tay một câu chạy lại đúng luật kiểm tra như câu AI sinh, rồi về `draft` để duyệt lại.

## Phase 4 — Quiz, Phòng, Làm bài (phác thảo)

- `quizzes/{quizId}` (bản nháp: `title`, `description`, `questionIds[]`, `settings`, `currentVersion`, hash để biết có thay đổi chưa publish), `quizVersions/{quizId}_{n}` (bản chụp câu hỏi, **bất biến** sau publish) và `quizVersionKeys/{quizId}_{n}` (đáp án, chỉ backend đọc). Hỗ trợ fork. Đã làm.
- `rooms/{roomId}`: `quizVersionId`, `hostId`, `code`, `status` (`WAITING` → `RUNNING` → `ENDED`), `maxParticipants`. Trạng thái do server quyết định.
- `attempts/{attemptId}` (đã làm cho làm bài một mình, phòng sẽ dùng lại): `quizId`, `quizVersion`, `participant` (`{ type: user|guest, id, displayName? }`), `participantKey`, `roomId?`, `seed` (server cấp, dựng lại đúng thứ tự câu/đáp án), `status` (`in_progress` → `submitted`), `answers`, `startedAt`, `deadlineAt` (server tính), `submittedAt`, `submitReason` (`submitted` | `timeout`), `result` (điểm + trạng thái từng câu), `events[]` (tab_hidden, tab_visible, window_blur, window_focus, copy, paste; tối đa 200).
- `attemptCounters/{actorType_actorId__quizId}`: `count` (số lượt đã mở, để chặn quá `maxAttempts`), `activeAttemptId` (lượt đang làm dở, để tiếp tục thay vì tạo mới).
- Câu hỏi nào không tự chấm được (trả lời ngắn) thì không tính vào điểm; nhiều đáp án chấm đúng-đủ hoặc sai, không có điểm từng phần ở V1.
- API: `POST /attempts` · `GET /attempts?quizId` · `GET /attempts/:id` · `PUT /attempts/:id/answers` · `POST /attempts/:id/submit` · `GET /attempts/:id/result` (chỉ sau khi nộp) · `POST /attempts/:id/events`.

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
- [x] Dọn tài liệu kẹt ở `uploading` (người dùng không bấm xác nhận): worker tự xóa file + bản ghi sau 24 giờ (`cleanupStaleUploads`, chạy mỗi 5 phút cùng `recoverStaleJobs`).
- [ ] Danh sách chỉ mục (index) tổng hợp, bổ sung khi viết truy vấn thật.
