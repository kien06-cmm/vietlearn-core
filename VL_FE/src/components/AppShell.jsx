// Chức năng: khung ứng dụng sau đăng nhập - thanh trên (tên thương hiệu), nội dung, thanh điều hướng dưới cho điện thoại.
const NAV_ITEMS = [
  { id: 'home', label: 'Trang chủ', icon: '🏠' },
  { id: 'documents', label: 'Tài liệu', icon: '📄' },
  { id: 'quiz', label: 'Quiz', icon: '🎯' },
  { id: 'settings', label: 'Cài đặt', icon: '⚙️' },
]

export default function AppShell({ route, planLabel, children }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">VietLearn</span>
        {planLabel && <span className="badge">{planLabel}</span>}
      </header>

      <main className="shell-main">{children}</main>

      <nav className="bottom-nav" aria-label="Menu chính">
        <div className="bottom-nav-inner">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              className="nav-item"
              href={`#/${item.id}`}
              aria-current={route === item.id ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  )
}
