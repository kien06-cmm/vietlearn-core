// Chức năng: màn chủ phòng (Phase 4) - mở phòng từ quiz đã publish, hiện mã phòng và link vào nhanh, xem ai đã vào và tiến độ làm bài (tự cập nhật), bắt đầu, kết thúc hoặc hủy phòng.
import { useCallback, useEffect, useState } from 'react'
import { createRoom, endRoom, getRoom, listMyRooms, startRoom } from '../services/api.js'
import { settingsText } from '../services/quizText.js'
import { useRoomSocket } from '../services/roomSocket.js'
import Icon from './Icon.jsx'
import RoomHeatmap from './RoomHeatmap.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'
import '../pages/Attempt.css'
import '../pages/Rooms.css'

const POLL_MS = 3000
const SLOW_POLL_MS = 30000 // khi WebSocket đang nối: chỉ hỏi thưa để đồng bộ lại cho chắc
const MAX_LIMIT = 200

const MODES = [
  { id: 'standard', label: 'Bình thường', hint: 'Dùng đúng cài đặt của quiz.' },
  { id: 'warmup', label: 'Khởi động', hint: 'Tối đa 5 câu, 5 phút. Mỗi người nhận một bộ câu khác nhau. Hợp để mở đầu tiết học.' },
  { id: 'exit', label: 'Exit ticket', hint: 'Tối đa 3 câu, 3 phút. Hợp để kiểm tra nhanh cuối giờ.' },
]
const modeLabel = (id) => MODES.find((m) => m.id === id)?.label || ''

function countsOf(list) {
  const n = (s) => list.filter((p) => p.status === s).length
  return { joined: list.length, inProgress: n('in_progress'), submitted: n('submitted') }
}

// Gộp một thay đổi của người tham gia (đẩy qua WebSocket). Thay đổi một phần của người chưa có trong danh sách thì bỏ qua, lần đồng bộ sau sẽ bù.
function mergeParticipant(d, p) {
  const known = d.participants.some((x) => x.key === p.key)
  if (!known && !p.displayName) return d
  const participants = known ? d.participants.map((x) => (x.key === p.key ? { ...x, ...p } : x)) : [...d.participants, p]
  return { ...d, participants, counts: countsOf(participants) }
}

const ROOM_STATUS_TEXT = { WAITING: 'Đang chờ', RUNNING: 'Đang làm bài', ENDED: 'Đã kết thúc' }
const PERSON_STATUS_TEXT = { waiting: 'Đang chờ', in_progress: 'Đang làm', submitted: 'Đã nộp' }

const dateText = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '')

export default function RoomHost({ getToken, quiz, onBack }) {
  const [code, setCode] = useState(null)
  const [data, setData] = useState(null) // phản hồi getRoom của chủ phòng
  const [open, setOpen] = useState(null) // các phòng chưa kết thúc của quiz này
  const [max, setMax] = useState('')
  const [mode, setMode] = useState('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmEnd, setConfirmEnd] = useState(false)

  // Phòng đang mở của quiz này (để mở lại sau khi tải lại trang)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await listMyRooms(await getToken())
        if (!cancelled) setOpen(res.rooms.filter((r) => r.quizId === quiz.id && r.status !== 'ENDED'))
      } catch {
        if (!cancelled) setOpen([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, quiz.id])

  const refresh = useCallback(async () => {
    if (!code) return
    try {
      setData(await getRoom(await getToken(), code))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [code, getToken])

  const ended = data?.room.status === 'ENDED'

  // Realtime: người vào phòng, nộp bài, đổi trạng thái phòng hiện ngay. Mất kết nối thì tự quay về hỏi định kỳ.
  const connected = useRoomSocket({
    code,
    getAuth: getToken,
    onMessage: (msg) => {
      if (msg.type === 'room') setData((d) => (d ? { ...d, room: msg.room } : d))
      else if (msg.type === 'participant') setData((d) => (d ? mergeParticipant(d, msg.participant) : d))
    },
  })

  useEffect(() => {
    if (!code) return
    refresh()
    if (ended) return
    const t = setInterval(refresh, connected ? SLOW_POLL_MS : POLL_MS)
    return () => clearInterval(t)
  }, [code, ended, connected, refresh])

  async function run(action) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const maxOk = max === '' || (Number.isInteger(Number(max)) && Number(max) >= 1 && Number(max) <= MAX_LIMIT)

  const handleCreate = () =>
    run(async () => {
      const res = await createRoom(await getToken(), quiz.id, { maxParticipants: max === '' ? undefined : Number(max), mode })
      setData(null)
      setCode(res.room.code)
    })

  const handleStart = () =>
    run(async () => {
      await startRoom(await getToken(), code)
      await refresh()
    })

  const handleEnd = () =>
    run(async () => {
      await endRoom(await getToken(), code)
      setConfirmEnd(false)
      await refresh()
      setNotice('Phòng đã kết thúc. Các bài đang làm dở đã được nộp tự động.')
    })

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(message)
    } catch {
      setNotice('Không sao chép được, bạn hãy chép tay.')
    }
  }

  // ---------- Chưa có phòng: tạo mới hoặc mở lại phòng đang mở ----------
  if (!code) {
    return (
      <>
        <section>
          <button className="btn btn-secondary" onClick={onBack}>
            <Icon name="back" size={18} /> Danh sách quiz
          </button>
          <h1>Mở phòng</h1>
          <p className="hint">{quiz.title}</p>
        </section>

        {open && open.length > 0 && (
          <section className="card">
            <h2>Phòng đang mở</h2>
            {open.map((r) => (
              <div key={r.code} className="row">
                <span>
                  <strong className="room-code-sm">{r.code}</strong> · {ROOM_STATUS_TEXT[r.status]} · {r.participantCount} người
                </span>
                <button className="btn btn-secondary" onClick={() => setCode(r.code)}>
                  Mở lại
                </button>
              </div>
            ))}
          </section>
        )}

        <section className="card">
          <div className="quiz-meta">
            <span className="chip">Version {quiz.currentVersion}</span>
            <span className="chip">{quiz.questionCount} câu</span>
          </div>
          <p className="hint">{settingsText(quiz.settings)}</p>
          <p className="hint">Phòng làm đúng version đang publish. Sửa quiz sau khi mở phòng không ảnh hưởng người trong phòng.</p>
          <fieldset className="room-modes">
            <legend>Kiểu phòng</legend>
            {MODES.map((m) => (
              <label key={m.id} className="check-row">
                <input type="radio" name="room-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
                <span>
                  <strong>{m.label}</strong>
                  <span className="hint"> {m.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            Số người tối đa (để trống là 50)
            <input type="number" inputMode="numeric" min={1} max={MAX_LIMIT} value={max} onChange={(e) => setMax(e.target.value)} placeholder="50" />
          </label>
          {!maxOk && (
            <p className="msg msg-error" role="alert">
              Số người từ 1 đến {MAX_LIMIT}.
            </p>
          )}
          {error && (
            <p className="msg msg-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={busy || !maxOk} onClick={handleCreate}>
            {busy ? 'Đang tạo phòng...' : 'Tạo phòng'}
          </button>
        </section>
      </>
    )
  }

  // ---------- Đã có phòng ----------
  const room = data?.room
  const link = `${window.location.origin}${window.location.pathname}#/join/${code}`

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onBack}>
          <Icon name="back" size={18} /> Danh sách quiz
        </button>
        <h1>{room?.title || quiz.title}</h1>
        {room && (
          <div className="quiz-meta">
            <span className={`badge ${room.status === 'RUNNING' ? 'badge-ok' : 'badge-draft'}`}>{ROOM_STATUS_TEXT[room.status]}</span>
            <span className="chip">{room.questionCount} câu</span>
            {room.mode && room.mode !== 'standard' && <span className="chip">{modeLabel(room.mode)}</span>}
            <span className="chip">{room.timeLimitMinutes ? `${room.timeLimitMinutes} phút` : 'Không giới hạn thời gian'}</span>
          </div>
        )}
      </section>

      <section className="card room-code-card">
        <p className="hint">Mã phòng</p>
        <p className="room-code" aria-label={`Mã phòng ${code.split('').join(' ')}`}>
          {code}
        </p>
        <p className="hint room-link">{link}</p>
        <div className="doc-actions">
          <button className="btn btn-secondary" onClick={() => copy(code, 'Đã sao chép mã phòng.')}>
            Sao chép mã
          </button>
          <button className="btn btn-secondary" onClick={() => copy(link, 'Đã sao chép link vào phòng.')}>
            Sao chép link
          </button>
        </div>
        <p className="hint">Người tham gia nhập mã hoặc mở link này. Họ có thể vào bằng tài khoản hoặc chỉ cần nhập tên.</p>
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="msg-ok">{notice}</p>}
      {!data && !error && <p className="hint">Đang tải phòng...</p>}

      {data && (
        <section className="card">
          <div className="room-counts">
            <span>
              <strong>{data.counts.joined}</strong>/{room.maxParticipants} đã vào
            </span>
            <span>
              <strong>{data.counts.inProgress}</strong> đang làm
            </span>
            <span>
              <strong>{data.counts.submitted}</strong> đã nộp
            </span>
          </div>

          {room.status === 'WAITING' && (
            <div className="doc-actions">
              <button className="btn btn-primary" disabled={busy} onClick={handleStart}>
                {busy ? 'Đang xử lý...' : `Bắt đầu cho ${data.counts.joined} người`}
              </button>
              <button className="btn btn-secondary" disabled={busy} onClick={handleEnd}>
                Hủy phòng
              </button>
            </div>
          )}

          {room.status === 'RUNNING' &&
            (confirmEnd ? (
              <div className="attempt-confirm">
                <p>
                  Kết thúc phòng? {data.counts.inProgress > 0 ? `${data.counts.inProgress} người đang làm sẽ bị nộp bài tự động theo phần đã lưu.` : 'Mọi người đã nộp bài.'}
                </p>
                <div className="doc-actions">
                  <button className="btn btn-danger" disabled={busy} onClick={handleEnd}>
                    {busy ? 'Đang kết thúc...' : 'Xác nhận kết thúc'}
                  </button>
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmEnd(false)}>
                    Để mọi người làm tiếp
                  </button>
                </div>
              </div>
            ) : (
              <div className="doc-actions">
                <button className="btn btn-secondary" onClick={() => setConfirmEnd(true)}>
                  Kết thúc phòng
                </button>
              </div>
            ))}

          {room.status === 'ENDED' && <p className="hint">Phòng đã kết thúc{room.endedAt ? ` lúc ${dateText(room.endedAt)}` : ''}.</p>}
        </section>
      )}

      {data && (
        <section className="card">
          <h2>Người tham gia ({data.participants.length})</h2>
          <p className="hint">{connected ? 'Cập nhật trực tiếp.' : 'Cập nhật định kỳ vài giây một lần.'}</p>
          {data.participants.length === 0 ? (
            <p className="hint">Chưa có ai vào phòng.</p>
          ) : (
            <ul className="room-people">
              {data.participants.map((p) => (
                <li key={p.key} className="room-person">
                  <span className="room-name">
                    {p.displayName}
                    {p.type === 'guest' && <span className="chip">Khách</span>}
                  </span>
                  <span className={`chip room-st room-st-${p.status}`}>
                    {PERSON_STATUS_TEXT[p.status]}
                    {p.status === 'submitted' && p.submitReason && p.submitReason !== 'submitted' ? ' (tự nộp)' : ''}
                  </span>
                  {p.score10 != null && (
                    <strong className="room-score">
                      {p.score10}/10 ({p.correct}/{p.gradable})
                    </strong>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data && room.status !== 'WAITING' && <RoomHeatmap getToken={getToken} code={code} submitted={data.counts.submitted} ended={ended} />}
    </>
  )
}
