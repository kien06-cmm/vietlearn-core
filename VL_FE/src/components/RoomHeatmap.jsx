// Chức năng: Heatmap cho chủ phòng (Phase 5) - "3 điều cần ôn lại", bản đồ nhiệt từng câu và chủ đề yếu của cả lớp.
// Chỉ hiện thống kê khi đủ 5 bài nộp (backend không trả gì dưới ngưỡng, nên không ai suy ra được từng bạn sai câu nào). Không có tên người nào trên màn này.
import { useEffect, useState } from 'react'
import { getRoomHeatmap } from '../services/api.js'
import MathText from './MathText.jsx'
import '../pages/Heatmap.css'

const LEVEL_TEXT = { hot: 'Sai rất nhiều', warm: 'Sai khá nhiều', mild: 'Sai một ít', cool: 'Hầu hết làm đúng', none: 'Chưa đủ dữ liệu' }
const pct = (rate) => (rate == null ? '–' : `${Math.round(rate * 100)}%`)

export default function RoomHeatmap({ getToken, code, submitted, ended }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState(null) // id câu đang xem chi tiết

  // Tải lại mỗi khi có thêm người nộp bài (số bài nộp đổi) và khi phòng kết thúc (các bài đang làm dở được nộp tự động)
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await getRoomHeatmap(await getToken(), code)
        if (!cancelled) {
          setData(res.heatmap)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }, 800) // gom nhiều bài nộp dồn dập thành một lần tải
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [getToken, code, submitted, ended])

  if (error && !data) {
    return (
      <section className="card">
        <h2>Điểm cả lớp hay sai</h2>
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      </section>
    )
  }
  if (!data) return null

  if (!data.ready) {
    const left = Math.max(data.needed - data.submitted, 0)
    return (
      <section className="card">
        <h2>Điểm cả lớp hay sai</h2>
        <p className="hint">
          Thống kê sẽ hiện khi có ít nhất {data.needed} bài nộp (hiện có {data.submitted}). {left > 0 ? `Còn thiếu ${left} bài.` : ''} Cần đủ số bài để không lộ được từng bạn sai câu nào.
        </p>
      </section>
    )
  }

  const current = data.questions.find((q) => q.id === picked)
  const topics = data.topics.filter((t) => t.enough && t.name)

  return (
    <>
      <section className="card">
        <h2>3 điều cần ôn lại</h2>
        {data.reviewPoints.length === 0 ? (
          <p className="hint">Cả lớp làm khá tốt: chưa có chủ đề hay câu nào có từ 30% bạn làm sai trở lên.</p>
        ) : (
          <ol className="hm-points">
            {data.reviewPoints.map((p, i) => (
              <li key={`${p.kind}-${p.topicId || p.questionId}`} className="hm-point">
                <span className="hm-rank">{i + 1}</span>
                <span className="hm-point-body">
                  <strong>{p.kind === 'question' ? <MathText text={p.title} /> : p.title}</strong>
                  <span className="hint">
                    {p.detail ? `${p.detail} · ` : ''}
                    {p.wrong}/{p.answered} lượt trả lời sai ({pct(p.wrongRate)})
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="hint">Dựa trên {data.submitted} bài đã nộp. Chỉ là gợi ý để bạn chọn nội dung nhắc lại ở đầu buổi sau.</p>
      </section>

      <section className="card">
        <h2>Bản đồ nhiệt theo câu</h2>
        <p className="hint">Càng đậm càng nhiều bạn làm sai. Bấm vào một ô để xem câu hỏi.</p>
        <div className="hm-grid" role="group" aria-label="Bản đồ nhiệt từng câu">
          {data.questions.map((q) => (
            <button
              key={q.id}
              type="button"
              className={`hm-cell hm-${q.level}${picked === q.id ? ' hm-cell-on' : ''}`}
              aria-pressed={picked === q.id}
              aria-label={`Câu ${q.no}: ${LEVEL_TEXT[q.level]}${q.wrongRate != null ? `, ${pct(q.wrongRate)} sai` : ''}`}
              onClick={() => setPicked(picked === q.id ? null : q.id)}
            >
              <span className="hm-no">{q.no}</span>
              <span className="hm-rate">{q.level === 'none' ? '–' : pct(q.wrongRate)}</span>
            </button>
          ))}
        </div>
        <ul className="hm-legend" aria-label="Chú giải">
          {['hot', 'warm', 'mild', 'cool', 'none'].map((l) => (
            <li key={l}>
              <span className={`hm-swatch hm-${l}`} /> {LEVEL_TEXT[l]}
            </li>
          ))}
        </ul>
        {current && (
          <div className="hm-detail">
            <p className="q-stem">
              <strong>Câu {current.no}. </strong>
              <MathText text={current.stem} />
            </p>
            <p className="hint">
              {current.answered} bạn trả lời, {current.wrong} bạn sai{current.skipped > 0 ? `, ${current.skipped} bạn bỏ trống` : ''}.
              {!current.enough && ' Chưa đủ lượt trả lời để kết luận câu này.'}
            </p>
          </div>
        )}
      </section>

      {topics.length > 0 && (
        <section className="card">
          <h2>Theo chủ đề</h2>
          <ul className="topic-rows">
            {topics.map((t) => (
              <li key={t.topicId} className="topic-row">
                <div className="topic-row-head">
                  <span>{t.name}</span>
                  <strong>{pct(t.wrongRate)} sai</strong>
                </div>
                {(t.subject || t.chapter) && <span className="hint">{[t.subject, t.chapter].filter(Boolean).join(' · ')}</span>}
                <div className="topic-bar" role="img" aria-label={`Sai ${pct(t.wrongRate)}`}>
                  <div className={`hm-fill hm-${t.level}`} style={{ width: `${Math.round((t.wrongRate || 0) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
