// Chức năng: màn hình giữ chỗ cho chức năng của các phase sau (Tài liệu: Phase 2, Quiz & phòng: Phase 4).
export default function ComingSoon({ icon, title, text }) {
  return (
    <section className="card">
      <span aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      <p className="hint">{text}</p>
      <span className="badge">Sắp có</span>
    </section>
  )
}
