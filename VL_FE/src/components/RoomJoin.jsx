// Chức năng: vào phòng làm bài bằng mã (Phase 4), dùng cho cả người có tài khoản và khách - nhập mã (và tên nếu là khách), phòng chờ tự cập nhật, chủ phòng bấm bắt đầu thì vào bài ngay, phòng kết thúc thì xem kết quả.
// Khách: tạo phiên khách (lưu trên máy) rồi dùng chuỗi 'Guest <token>' làm token cho mọi API.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createGuestSession, getAttemptResult, getRoom, joinRoom } from '../services/api.js'
import { clearGuest, loadGuest, saveGuest } from '../services/guestSession.js'
import { useRoomSocket } from '../services/roomSocket.js'
import AttemptRunner from './AttemptRunner.jsx'
import AttemptResult from './AttemptResult.jsx'
import Icon from './Icon.jsx'
import '../pages/Rooms.css'

const POLL_MS = 2500
const SLOW_POLL_MS = 20000 // khi WebSocket đang nối: chỉ hỏi thưa để đồng bộ lại cho chắc
const MODE_TEXT = { warmup: 'Khởi động', exit: 'Exit ticket' }

const RULES = (
  <ul className="attempt-rules">
    <li>Bài được lưu tự động. Mất mạng hoặc tải lại trang thì vào lại phòng bằng cùng mã và cùng tên để làm tiếp.</li>
    <li>Hệ thống ghi nhận khi bạn chuyển tab, rời trình duyệt, sao chép hoặc dán trong lúc làm bài. Chỉ ghi nhận, bài không bị khóa.</li>
    <li>Đáp án đúng chỉ hiện sau khi nộp bài.</li>
  </ul>
)

// Xem kết quả khi phòng đã kết thúc (vào lại sau khi chủ phòng đã đóng phòng)
function EndedView({ getAuth, attemptId, onLeave }) {
  const [res, setRes] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!attemptId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await getAttemptResult(await getAuth(), attemptId)
        if (!cancelled) setRes(r)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getAuth, attemptId])

  if (res) return <AttemptResult res={res} onExit={onLeave} exitLabel="Rời phòng" />

  return (
    <section className="card empty">
      <h2>Phòng đã kết thúc</h2>
      {attemptId && !error && <p className="hint">Đang tải kết quả của bạn...</p>}
      {!attemptId && <p className="hint">Bạn chưa làm bài nào trong phòng này.</p>}
      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-secondary" onClick={onLeave}>
        Rời phòng
      </button>
    </section>
  )
}

// Phòng chờ + làm bài. Hỏi trạng thái phòng định kỳ cho tới khi phòng chạy hoặc kết thúc.
function RoomView({ code, initialRoom, getAuth, displayName, onLeave }) {
  const [room, setRoom] = useState(initialRoom)
  const [attemptId, setAttemptId] = useState(null)
  const [offline, setOffline] = useState(false)
  const [fatal, setFatal] = useState('')
  const [inAttempt, setInAttempt] = useState(false)

  const status = room.status

  // Đồng bộ trạng thái phòng bằng REST (lần đầu, khi nối lại, và dự phòng khi WebSocket không nối được)
  const sync = useCallback(async () => {
    try {
      const res = await getRoom(await getAuth(), code)
      setRoom(res.room)
      setAttemptId(res.me?.attemptId ?? null)
      setOffline(false)
      if (res.room.status === 'RUNNING') setInAttempt(true)
    } catch (err) {
      if (err.status === 404 || err.status === 401) setFatal(err.message)
      else setOffline(true)
    }
  }, [code, getAuth])

  // Realtime: chủ phòng bấm bắt đầu/kết thúc là máy này biết ngay (không phải chờ chu kỳ hỏi tiếp theo)
  const connected = useRoomSocket({
    code,
    getAuth,
    enabled: !fatal,
    onMessage: (msg) => {
      if (msg.type !== 'room') return
      setRoom(msg.room)
      if (msg.room.status === 'RUNNING') setInAttempt(true)
      if (msg.room.status === 'ENDED') sync() // lấy id lượt làm để xem kết quả
    },
  })

  useEffect(() => {
    if (inAttempt || status === 'ENDED') return
    sync()
    const t = setInterval(sync, connected ? SLOW_POLL_MS : POLL_MS)
    return () => clearInterval(t)
  }, [sync, inAttempt, status, connected])

  if (fatal) {
    return (
      <section className="card empty">
        <h2>Không vào được phòng</h2>
        <p className="msg msg-error" role="alert">
          {fatal}
        </p>
        <button className="btn btn-secondary" onClick={onLeave}>
          Quay lại
        </button>
      </section>
    )
  }

  if (inAttempt) {
    return (
      <AttemptRunner getToken={getAuth} roomCode={code} onExit={onLeave} exitLabel="Rời phòng" roomEnded={status === 'ENDED'} live={connected} />
    )
  }

  if (status === 'ENDED') {
    return <EndedView getAuth={getAuth} attemptId={attemptId} onLeave={onLeave} />
  }

  return (
    <>
      <section>
        <h1>{room.title}</h1>
        <div className="quiz-meta">
          <span className="chip">Mã phòng {room.code}</span>
          {MODE_TEXT[room.mode] && <span className="chip">{MODE_TEXT[room.mode]}</span>}
          <span className="chip">{room.questionCount} câu</span>
          {room.timeLimitMinutes ? <span className="chip">{room.timeLimitMinutes} phút</span> : <span className="chip">Không giới hạn thời gian</span>}
        </div>
      </section>

      <section className="card room-wait" aria-live="polite">
        <span className="tile-icon">
          <Icon name="clock" size={26} />
        </span>
        <h2>Đang chờ chủ phòng bắt đầu</h2>
        <p className="hint">
          Bạn đang vào với tên <strong>{displayName}</strong>. Đã có {room.participantCount} người trong phòng. Khi chủ phòng bấm bắt đầu, bài sẽ tự mở. Bạn không cần bấm gì.
        </p>
        {offline && <p className="msg msg-error">Mất kết nối, đang thử lại...</p>}
        {RULES}
        <button className="btn btn-secondary" onClick={onLeave}>
          Rời phòng
        </button>
      </section>
    </>
  )
}

export default function RoomJoin({ getToken, isGuest = false, initialCode = '', onBack, backLabel = 'Quay lại' }) {
  const [stage, setStage] = useState('form') // form | joining | in
  const [code, setCode] = useState(initialCode.toUpperCase())
  const [name, setName] = useState(() => (isGuest ? loadGuest()?.guest.displayName || '' : ''))
  const [error, setError] = useState('')
  const [joined, setJoined] = useState(null) // { room, displayName }
  const sessionRef = useRef(isGuest ? loadGuest() : null)

  // Token dùng cho mọi API: tài khoản dùng getToken, khách dùng 'Guest <token>'
  const getAuth = useCallback(async () => (isGuest ? `Guest ${sessionRef.current.token}` : getToken()), [isGuest, getToken])

  async function handleJoin(e) {
    e.preventDefault()
    setError('')
    setStage('joining')
    try {
      if (isGuest) {
        const trimmed = name.trim()
        if (!trimmed) throw new Error('Hãy nhập tên hiển thị.')
        // Cùng tên với phiên cũ thì dùng lại phiên (vào lại đúng bài đang làm dở); đổi tên thì là người mới
        const cur = sessionRef.current
        if (!cur || cur.guest.displayName !== trimmed) {
          const s = await createGuestSession(trimmed)
          sessionRef.current = { token: s.token, guest: s.guest }
          saveGuest(sessionRef.current)
        }
      }
      const res = await joinRoom(await getAuth(), code)
      // Ghi mã vào địa chỉ để tải lại trang vẫn còn mã (không kích hoạt chuyển trang)
      window.history.replaceState(null, '', `#/join/${res.room.code}`)
      setJoined({ room: res.room, displayName: res.me.displayName })
      setStage('in')
    } catch (err) {
      if (isGuest && err.status === 401) {
        clearGuest()
        sessionRef.current = null
        setError('Phiên của bạn đã hết hạn. Bấm Vào phòng để thử lại.')
      } else {
        setError(err.message)
      }
      setStage('form')
    }
  }

  function handleLeave() {
    setJoined(null)
    setStage('form')
  }

  if (stage === 'in' && joined) {
    return <RoomView code={joined.room.code} initialRoom={joined.room} getAuth={getAuth} displayName={joined.displayName} onLeave={handleLeave} />
  }

  return (
    <>
      <section>
        {onBack && (
          <button className="btn btn-secondary" onClick={onBack}>
            <Icon name="back" size={18} /> {backLabel}
          </button>
        )}
        <h1>Vào phòng</h1>
        <p className="hint">
          Nhập mã phòng mà người tổ chức đã đưa cho bạn.
          {isGuest && ' Bạn không cần tài khoản.'}
        </p>
      </section>

      <form className="card" onSubmit={handleJoin}>
        <label>
          Mã phòng
          <input
            className="room-code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="ABC234"
            required
          />
        </label>
        {isGuest && (
          <label>
            Tên hiển thị
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoComplete="nickname" placeholder="Ví dụ: Minh Anh 10A2" required />
          </label>
        )}
        {error && (
          <p className="msg msg-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={stage === 'joining' || !code.trim()}>
          {stage === 'joining' ? 'Đang vào phòng...' : 'Vào phòng'}
        </button>
        {RULES}
      </form>
    </>
  )
}
