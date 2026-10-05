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

## 8. Việc chưa chốt

- [ ] Tách production (Firebase project + Render service + Vercel).
- [ ] Biến `DATABASE_URL` trên Render: giữ hay bỏ (liên quan Postgres).
- [ ] Domain riêng cho frontend và API.
- [ ] Chọn nhà cung cấp AI và lớp trừu tượng (Phase 3).
- [ ] Hàng đợi: Redis (BullMQ) hay cách khác.
