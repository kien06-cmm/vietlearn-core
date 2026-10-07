// Chức năng: biểu tượng thương hiệu VietLearn - quyển vở mở với vệt bút dạ quang. Đổi màu theo token nên dùng được cả chế độ tối.
export default function BrandMark({ size = 30 }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" className="bm-bg" />
      <path d="M6.5 9.5c3.3-.9 6.4-.5 9.5 1.6v12.6c-3-2-6.2-2.4-9.5-1.5z" className="bm-page" />
      <path d="M25.5 9.5c-3.3-.9-6.4-.5-9.5 1.6v12.6c3-2 6.2-2.4 9.5-1.5z" className="bm-page bm-page-r" />
      <rect x="18.2" y="13.4" width="5.2" height="2.6" rx="1.3" className="bm-hl" />
      <rect x="18.2" y="18" width="3.4" height="1.6" rx=".8" className="bm-line" />
    </svg>
  )
}
