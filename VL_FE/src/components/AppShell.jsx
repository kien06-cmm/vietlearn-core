// Chức năng: khung ứng dụng sau đăng nhập - thanh trên (logo, tên thương hiệu, chip AI credits), nội dung, thanh điều hướng dưới cho điện thoại.
import BrandMark from './BrandMark.jsx'
import { CreditChip } from './CreditMeter.jsx'
import Icon from './Icon.jsx'

const NAV_ITEMS = [
  { id: 'home', label: 'Trang chủ', icon: 'home' },
  { id: 'documents', label: 'Tài liệu', icon: 'file' },
  { id: 'questions', label: 'Câu hỏi', icon: 'list' },
  { id: 'quiz', label: 'Quiz', icon: 'target' },
  { id: 'settings', label: 'Cài đặt', icon: 'settings' },
]

export default function AppShell({ route, planLabel, children }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <a className="brand-wrap" href="#/home" aria-label="VietLearn - về Trang chủ">
          <BrandMark size={30} />
          <span className="wordmark">
            Viet<span>Learn</span>
          </span>
        </a>
        <div className="header-right">
          <CreditChip />
          {planLabel && <span className="badge badge-plan">{planLabel}</span>}
        </div>
      </header>

      {/* key theo route: đổi trang thì phát lại hiệu ứng xuất hiện */}
      <main className="shell-main" key={route}>
        {children}
      </main>

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
                <Icon name={item.icon} size={21} />
              </span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  )
}
