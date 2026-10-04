// Chức năng: màn hình giữ chỗ cho chức năng của các phase sau (Tài liệu: Phase 2, Quiz & phòng: Phase 4).
import Icon from '../components/Icon.jsx'

// icon: tên icon trong components/Icon.jsx (vd: 'file', 'target')
export default function ComingSoon({ icon, title, text }) {
  return (
    <section className="card empty">
      <span className="tile-icon">
        <Icon name={icon} size={26} />
      </span>
      <h2>{title}</h2>
      <p className="hint">{text}</p>
      <span className="badge">Sắp có</span>
    </section>
  )
}
