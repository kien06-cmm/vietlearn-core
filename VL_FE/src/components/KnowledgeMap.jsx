// Chức năng: Bản đồ kiến thức (Phase 5) - mức thành thạo từng chủ đề theo Môn -> Chương -> Chủ đề, tính trên 30 câu gần nhất của mỗi chủ đề.
// Chủ đề cần ít nhất 5 câu mới được xếp loại; trước đó hiện "Chưa đủ dữ liệu" để không kết luận vội. Mức độ luôn có chữ, không chỉ dựa vào màu.
import { useEffect, useState } from 'react'
import { getMastery } from '../services/api.js'
import Icon from './Icon.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'
import '../pages/Attempt.css'
import '../pages/Review.css'

const LEVEL_TEXT = { new: 'Chưa đủ dữ liệu', weak: 'Cần luyện', learning: 'Đang tiến bộ', strong: 'Vững' }
const MIN_SAMPLE = 5 // khớp MIN_SAMPLE ở backend (quiz/masteryRules.js)

// Thanh phần trăm. Chủ đề chưa đủ dữ liệu thì không vẽ thanh, tránh gây hiểu nhầm là điểm thật.
function Bar({ percent, level }) {
  if (level === 'new' || percent == null) return null
  return (
    <div className="topic-bar" role="img" aria-label={`Thành thạo ${percent}%`}>
      <div className={`topic-bar-fill mastery-fill mastery-fill-${level}`} style={{ width: `${percent}%` }} />
    </div>
  )
}

function Level({ level }) {
  return <span className={`mastery-level mastery-level-${level}`}>{LEVEL_TEXT[level]}</span>
}

function TopicRow({ t }) {
  return (
    <li className="topic-row">
      <div className="topic-row-head">
        <span>{t.name || 'Chủ đề đã bị xóa'}</span>
        <strong>{t.level === 'new' ? `${t.sample}/${MIN_SAMPLE} câu` : `${t.percent}%`}</strong>
      </div>
      <Level level={t.level} />
      <Bar percent={t.percent} level={t.level} />
    </li>
  )
}

export default function KnowledgeMap({ getToken, onBack }) {
  const [data, setData] = useState(null) // null: đang tải
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getMastery(await getToken())
        if (!cancelled) setData(res)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken])

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onBack}>
          <Icon name="back" size={18} /> Ôn tập
        </button>
        <h1>Bản đồ kiến thức</h1>
        <p className="hint">
          Mức thành thạo từng chủ đề, tính trên 30 câu gần nhất. Câu bạn đánh dấu “Đoán” mà trúng chỉ tính nửa điểm. Cần ít nhất {MIN_SAMPLE} câu mới
          xếp loại.
        </p>
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="hint">Đang tải bản đồ kiến thức...</p>}

      {data && data.map.length === 0 && (
        <section className="card empty">
          <h2>Chưa có dữ liệu</h2>
          <p className="hint">Làm quiz hoặc ôn tập vài câu theo chủ đề, bản đồ sẽ hiện ở đây.</p>
        </section>
      )}

      {data && data.map.length > 0 && (
        <>
          <section className="card">
            <h2>Tổng quan</h2>
            <div className="quiz-meta">
              <span className="chip">Vững {data.counts.strong}</span>
              <span className="chip">Đang tiến bộ {data.counts.learning}</span>
              <span className="chip">Cần luyện {data.counts.weak}</span>
              <span className="chip">Chưa đủ dữ liệu {data.counts.new}</span>
            </div>
            {data.weakest.length > 0 && (
              <>
                <p className="hint">Nên ưu tiên:</p>
                <ul className="conf-rows">
                  {data.weakest.map((t) => (
                    <li key={t.topicId} className="conf-row">
                      <span>{t.name || 'Chủ đề đã bị xóa'}</span>
                      <strong>{t.percent}%</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {data.map.map((s) => (
            <section key={s.subject} className="card">
              <div className="topic-row-head">
                <h2>{s.subject}</h2>
                <strong>{s.level === 'new' ? '' : `${s.percent}%`}</strong>
              </div>
              <Level level={s.level} />
              {s.chapters.map((c) => (
                <div key={c.chapter} className="mastery-chapter">
                  <h3>{c.chapter}</h3>
                  <ul className="topic-rows">
                    {c.topics.map((t) => (
                      <TopicRow key={t.topicId} t={t} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </>
  )
}
