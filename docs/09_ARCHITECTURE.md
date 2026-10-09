# 09_ARCHITECTURE — Kiến trúc VietLearn V1

> Bản nháp theo 13_V1_ROADMAP. Cập nhật khi có quyết định mới.

## 1. Tổng quan

```
Trình duyệt (điện thoại / máy tính)
   │  1. Đăng nhập (Firebase Auth SDK)
   │  2. Gọi API kèm  Authorization: Bearer <ID token>
   ▼
Vercel (VL_FE)  ──────────►  Render (VL_BE: API)  ──────►  Firestore (Admin SDK)
 React + Vite                 Express, WebSocket           Storage (tệp tài liệu)
 chỉ có cấu hình công khai    giữ mọi secret               nhà cung cấp AI (chỉ gọi từ Render)
                                    │
                                    ▼
                              Render Worker + hàng đợi
                              (trích văn bản, sinh câu hỏi)
```

## 2. Thành phần

| Thành phần | Dịch vụ | Vai trò |
|---|---|---|
| Frontend (VL_FE) | Vercel | Giao diện mobile-first, đăng nhập bằng Firebase Auth |
| API (VL_BE) | Render Web Service | Xác thực token, phân quyền, nghiệp vụ, chấm bài |
| Realtime | Render (WebSocket) | Phòng làm bài. Không dùng Firestore listener cho phòng đông người |
| Worker | Render Background Worker | Xử lý tài liệu, gọi AI, retry, dead-letter |
| Dữ liệu | Firestore (`asia-southeast1`) | Dữ liệu ứng dụng |
| Tệp | Supabase Storage (gói free, không cần thẻ) | PDF, DOCX, TXT người dùng tải lên. Firebase Storage bắt buộc gói Blaze nên không dùng |

## 3. Môi trường

| | Staging | Production |
|---|---|---|
| Firebase | `vietlearn-staging` | chưa tạo |
| Render | `vietlearn-core` | chưa tạo |
| Vercel | dùng chung `vietlearn-core` (tạm thời) | chưa tách |

Quy tắc: mọi phase đều deploy lên staging trước. Chưa public khi chưa qua Quality Gate (Phase 6).

## 4. Xác thực và phân quyền

- Đăng ký, đăng nhập, quên mật khẩu: Firebase Auth (email/mật khẩu).
- Frontend gửi `Authorization: Bearer <ID token>`. Backend kiểm tra bằng `admin.auth().verifyIdToken()`.
- Dùng domain cùng gốc (ví dụ `app.` và `api.`) để tránh lỗi CORS/cookie. Trước khi ra mắt, giới hạn CORS đúng domain frontend (hiện đang mở cho mọi nguồn).
- Phân quyền theo **resource/context**, không theo vai trò toàn cục: `owner`, `host`, `participant`, `admin`. Một người có thể là host ở phòng này và participant ở phòng khác.
- Khách (guest): token tạm thời cho người vào phòng.
- Firestore Rules: **chặn toàn bộ truy cập trực tiếp từ client** (database đang ở production mode). Mọi đọc/ghi đi qua backend dùng Admin SDK.
- Đáp án đúng không bao giờ gửi xuống client trước khi nộp bài.

## 5. Secret

- Khóa service account Firebase, key nhà cung cấp AI: chỉ ở biến môi trường trên Render (`FIREBASE_SERVICE_ACCOUNT_JSON`, ...).
- Vercel chỉ chứa biến `VITE_*` (cấu hình công khai của Firebase, địa chỉ API). Không bao giờ đặt secret vào `VITE_*`.

## 6. Quy tắc chi phí

- Render gói miễn phí tự ngủ khi không dùng. Không phù hợp cho API/realtime. Dùng gói trả phí khi chạy thật.
- Worker và Redis (cho hàng đợi) là dịch vụ riêng trên Render, tính phí riêng.
- Firestore tính theo lượt đọc/ghi. Thiết kế dữ liệu tổng hợp sẵn (denormalize) để giảm lượt đọc.
- Chạy AI và xử lý tài liệu trên Render, không chạy trên Vercel Functions (giới hạn thời gian chạy).
- Vercel gói Hobby dành cho mục đích phi thương mại. Cần chuyển gói phù hợp trước khi thu phí.
- Đặt billing alert cho Firebase, Render, nhà cung cấp AI.

## 7. Quan sát và vận hành (Phase 1 trở đi)

- Rate limiting trên API.
- Log có cấu trúc, theo dõi lỗi bằng Sentry hoặc tương đương.
- Bộ sự kiện analytics đầu tiên: `visit`, `register`.

## 8. Realtime phòng làm bài (Phase 4)

- WebSocket tại `/ws`, chạy chung cổng với API (`realtime/wsServer.js`). Client mở kết nối rồi gửi ngay `{ type: 'auth', auth, code }` (`Bearer <token>` hoặc `Guest <token>`), vì trình duyệt không gắn được header cho WebSocket. Server kiểm tra token và vai trò trong phòng (chủ phòng hay người đã vào) rồi trả `{ type: 'ready', role }`.
- Chỉ đẩy **thay đổi**: phòng đổi trạng thái/số người (gửi cả chủ phòng và người tham gia), người tham gia đổi tiến độ (chỉ gửi chủ phòng). Dữ liệu gốc vẫn ở Firestore và lấy bằng REST. WebSocket không nối được thì giao diện tự quay về hỏi định kỳ (3 giây; thưa hơn, 20-30 giây, khi đang nối để đồng bộ lại).
- Giới hạn: 2000 kết nối/instance, 400 kết nối/phòng, 20 tin/10 giây mỗi kết nối, tin tối đa 2 KB, ping mỗi 30 giây để dọn kết nối chết. Mã đóng 4001 xác thực lỗi, 4003 sai nguồn (origin), 4004 không có phòng hoặc chưa vào phòng, 4008 quá tải; client không tự nối lại với mã 4xxx.
- **Chỉ chạy MỘT instance API** trên Render: hub nằm trong bộ nhớ của tiến trình (`realtime/roomHub.js`). Muốn chạy nhiều instance thì cần thêm kênh chung (Redis pub/sub). Không ảnh hưởng tính đúng đắn: chấm bài, chuyển trạng thái phòng đều làm qua REST + transaction.
- Chấm bài ở server; đáp án đúng (`quizVersionKeys`) chỉ được đọc khi chấm hoặc xem lại SAU khi đã nộp. Đề gửi xuống chỉ có id, loại, đề bài, đáp án (mỗi đáp án mang index gốc, không tiết lộ đáp án đúng).
- Rate limit: toàn API 120 request/phút/IP, riêng `/attempts` và `/rooms` rộng theo IP (cả lớp thường chung Wi-Fi) nhưng chặt theo từng người.

## 9. Việc chưa chốt

- [ ] Tách production (Firebase project + Render service + Vercel).
- [ ] Biến `DATABASE_URL` trên Render: giữ hay bỏ (liên quan Postgres).
- [ ] Domain riêng cho frontend và API.
- [ ] Chọn nhà cung cấp AI và lớp trừu tượng (Phase 3).
- [ ] Hàng đợi: Redis (BullMQ) hay cách khác.
- [ ] Realtime nhiều instance: cần Redis pub/sub nếu vượt một instance (V1 chạy một instance là đủ).

## 10. Vòng lặp học tập (Phase 5)

- Sau khi nộp bài, `finalizeAttempt` (chỉ chạy một lần cho mỗi bài, trong nền, lỗi không làm hỏng việc chấm) ghi: sổ lỗi sai và mức thành thạo của người dùng (chỉ tài khoản), và thống kê phòng (nếu bài làm trong phòng) cho Heatmap của chủ phòng.
- Chi phí đọc/ghi: thống kê phòng ghi bằng `increment` một batch mỗi bài nộp (1 + số câu tự chấm, tối đa 101 lần ghi); chủ phòng xem Heatmap tốn 1 lượt đọc phòng + 1 lượt đọc version + số câu + tối đa 100 chủ đề, không đọc lại từng bài làm. Giao diện chủ phòng chỉ tải lại Heatmap khi số bài nộp đổi.
- Quyền riêng tư: Heatmap chỉ hiện khi đủ 5 bài nộp, chỉ có số liệu gộp, không có tên người (ngưỡng được áp ở backend nên client không lách được). Chỉ chủ phòng đọc được; người khác nhận 404.
- Khách → tài khoản: chứng minh quyền sở hữu bằng token khách (bí mật chỉ máy của khách có, Firestore chỉ lưu bản băm), thêm đăng nhập tài khoản. Một token khách chỉ chuyển được một lần cho mỗi bài (transaction), giới hạn 6 lần gọi/phút/người, tối đa 50 bài mỗi lần.
