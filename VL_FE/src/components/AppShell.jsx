// Chức năng: khung ứng dụng sau đăng nhập - thanh trên (logo + tên thương hiệu), nội dung, thanh điều hướng dưới cho điện thoại.
import Icon from './Icon.jsx'

const NAV_ITEMS = [
  { id: 'home', label: 'Trang chủ', icon: 'home' },
  { id: 'documents', label: 'Tài liệu', icon: 'file' },
  { id: 'quiz', label: 'Quiz', icon: 'target' },
  { id: 'settings', label: 'Cài đặt', icon: 'settings' },
]

export default function AppShell({ route, planLabel, children }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand-wrap">
          <span className="logo-mark">
            <Icon name="cap" size={18} />
          </span>
          <span className="brand">VietLearn</span>
        </div>
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
              <span className="nav-icon">
                <Icon name={item.icon} size={22} />
              </span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  )
}
