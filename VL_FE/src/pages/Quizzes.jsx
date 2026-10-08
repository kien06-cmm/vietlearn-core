// Chức năng: trang Quiz - danh sách quiz của tôi (version đã publish, thay đổi chưa publish), tạo/sửa, lịch sử version, sao chép, xóa.
import { useCallback, useEffect, useState } from 'react'
import { deleteQuiz, forkQuiz, listQuizzes } from '../services/api.js'
import { settingsText } from '../services/quizText.js'
import Icon from '../components/Icon.jsx'
import QuizEditor from '../components/QuizEditor.jsx'
import QuizVersions from '../components/QuizVersions.jsx'
import AttemptRunner from '../components/AttemptRunner.jsx'
import RoomHost from '../components/RoomHost.jsx'
import './Questions.css'
import './Quizzes.css'

// Danh sách quiz
function QuizList({ getToken, onCreate, onEdit, onVersions, onTake, onRoom }) {
  const [quizzes, setQuizzes] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmId, setConfirmId] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const reload = useCallback(async () => {
    try {
      const res = await listQuizzes(await getToken())
      setQuizzes(res.quizzes)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [getToken])

  useEffect(() => {
    reload()
  }, [reload])

  // Chạy một thao tác trên 1 quiz: khóa nút của quiz đó trong lúc chạy, báo lỗi nếu có
  async function run(id, action) {
    setBusyId(id)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const handleFork = (q) =>
    run(q.id, async () => {
      const res = await forkQuiz(await getToken(), q.id)
      await reload()
      setNotice(
        res.dropped > 0
          ? `Đã sao chép. ${res.dropped} câu không còn dùng được (đã xóa hoặc chưa duyệt) nên bị bỏ khỏi bản sao.`
          : 'Đã sao chép thành quiz mới.'
      )
    })

  const handleDelete = (q) =>
    run(q.id, async () => {
      await deleteQuiz(await getToken(), q.id)
      setQuizzes((cur) => cur.filter((x) => x.id !== q.id))
      setConfirmId(null)
    })

  return (
    <>
      <section>
        <h1>Quiz</h1>
        <p className="hint">Ghép các câu hỏi đã duyệt thành quiz. Publish để tạo version cố định cho người làm bài.</p>
        <button className="btn btn-primary btn-icon" onClick={onCreate}>
          <Icon name="target" size={20} />
          Tạo quiz mới
        </button>
        <a className="btn btn-secondary" href="#/join">
          Vào phòng bằng mã
        </a>
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="msg-ok">{notice}</p>}
      {quizzes === null && !error && <p className="hint">Đang tải danh sách quiz...</p>}

      {quizzes && quizzes.length === 0 && (
        <section className="card empty">
          <span className="tile-icon">
            <Icon name="target" size={26} />
          </span>
          <h2>Chưa có quiz nào</h2>
          <p className="hint">Hãy duyệt vài câu hỏi ở trang Câu hỏi, rồi tạo quiz đầu tiên.</p>
        </section>
      )}

      {quizzes?.map((q) => {
        const busy = busyId === q.id
        return (
          <article key={q.id} className="card">
            <div className="quiz-meta">
              <span className={`badge ${q.currentVersion ? 'badge-ok' : 'badge-draft'}`}>
                {q.currentVersion ? `Version ${q.currentVersion}` : 'Chưa publish'}
              </span>
              {q.currentVersion > 0 && q.hasUnpublishedChanges && <span className="chip">Có thay đổi chưa publish</span>}
              <span className="chip">{q.questionCount} câu</span>
            </div>
            <h2 className="quiz-title">{q.title}</h2>
            {q.description && <p className="hint">{q.description}</p>}
            <p className="hint">{settingsText(q.settings)}</p>

            {confirmId === q.id ? (
              <div className="doc-actions">
                <button className="btn btn-danger" disabled={busy} onClick={() => handleDelete(q)}>
                  {busy ? 'Đang xóa...' : 'Xác nhận xóa'}
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmId(null)}>
                  Hủy
                </button>
              </div>
            ) : (
              <div className="doc-actions">
                <button className="btn btn-secondary" disabled={busy} onClick={() => onEdit(q.id)}>
                  Sửa
                </button>
                {q.currentVersion > 0 && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => onRoom(q)}>
                    Mở phòng
                  </button>
                )}
                {q.currentVersion > 0 && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => onTake(q)}>
                    Làm thử
                  </button>
                )}
                {q.currentVersion > 0 && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => onVersions(q)}>
                    Lịch sử version
                  </button>
                )}
                <button className="btn btn-secondary" disabled={busy} onClick={() => handleFork(q)}>
                  {busy ? 'Đang sao chép...' : 'Sao chép'}
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirmId(q.id)}>
                  Xóa
                </button>
              </div>
            )}
          </article>
        )
      })}
    </>
  )
}

export default function Quizzes({ getToken }) {
  // view: { name: 'list' } | { name: 'edit', id? } (id rỗng = tạo mới) | { name: 'versions', quiz } | { name: 'attempt', quiz, run }
  const [view, setView] = useState({ name: 'list' })
  const toList = () => setView({ name: 'list' })

  if (view.name === 'room') {
    return <RoomHost key={view.quiz.id} getToken={getToken} quiz={view.quiz} onBack={toList} />
  }

  if (view.name === 'attempt') {
    return (
      <AttemptRunner
        key={view.run}
        getToken={getToken}
        quiz={view.quiz}
        onExit={toList}
        onRetry={() => setView({ name: 'attempt', quiz: view.quiz, run: view.run + 1 })}
      />
    )
  }

  if (view.name === 'edit') {
    return <QuizEditor key={view.id ?? 'new'} getToken={getToken} quizId={view.id} onBack={toList} />
  }
  if (view.name === 'versions') {
    return (
      <QuizVersions
        getToken={getToken}
        quiz={view.quiz}
        onBack={toList}
        onForked={(id) => setView({ name: 'edit', id })}
      />
    )
  }
  return (
    <QuizList
      getToken={getToken}
      onCreate={() => setView({ name: 'edit' })}
      onEdit={(id) => setView({ name: 'edit', id })}
      onVersions={(quiz) => setView({ name: 'versions', quiz })}
      onTake={(quiz) => setView({ name: 'attempt', quiz, run: 1 })}
      onRoom={(quiz) => setView({ name: 'room', quiz })}
    />
  )
}
