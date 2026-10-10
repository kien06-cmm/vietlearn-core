// Chức năng: các hàm gọi API backend trên Render (health, hồ sơ /me, tài liệu /documents, câu hỏi + AI /questions /topics, quiz, làm bài, phòng, ôn tập /review, ghi sự kiện analytics).
export const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://vietlearn-core.onrender.com'

// Gửi request tới backend. body (nếu có) được gửi dạng JSON.
async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {}
  // Token khách có dạng 'Guest <token>' (gửi nguyên); token đăng nhập Firebase gửi kèm 'Bearer'
  if (token) headers.Authorization = token.startsWith('Guest ') ? token : `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    // Lấy thông báo tiếng Việt từ backend nếu có, kèm mã trạng thái để giao diện xử lý riêng từng trường hợp
    let data = null
    try {
      data = await res.json()
    } catch {
      // phản hồi không phải JSON
    }
    const err = new Error(data?.message || `Backend trả về lỗi ${res.status}`)
    err.status = res.status
    err.code = data?.code
    err.resetsAt = data?.resetsAt // có khi hết credits (402): mốc credits được làm mới
    err.window = data?.window // 'day' | 'week': hạn mức nào đang chặn (hết ngày hay hết tuần)
    err.reason = data?.reason // 429 của AI: 'overloaded' (quá tải) | 'quota-daily' (hết hạn mức hôm nay) | 'unavailable'
    // Thời gian chờ gợi ý (giây) khi AI quá tải: ưu tiên thân phản hồi, dự phòng header Retry-After
    const retrySec = Number(data?.retryAfter ?? res.headers.get('Retry-After'))
    if (Number.isFinite(retrySec) && retrySec > 0) err.retryAfterMs = retrySec * 1000
    throw err
  }
  return res.json()
}

export function getHealth() {
  return request('/health')
}

export function getMe(token) {
  return request('/me', { token })
}

// Sửa hồ sơ: { displayName?, settings?: { darkMode?, fontSize? } }
export function updateMe(token, changes) {
  return request('/me', { token, method: 'PATCH', body: changes })
}

// Xóa tài khoản (xóa mềm)
export function deleteMe(token) {
  return request('/me', { token, method: 'DELETE' })
}

// ---------- Tài liệu (Phase 2) ----------

// Hạn mức theo gói: { plan, usedDocuments, maxFileBytes, maxDocuments, maxPages }
export function getQuota(token) {
  return request('/documents/quota', { token })
}

export function listDocuments(token) {
  return request('/documents', { token })
}

export function getDocument(token, id) {
  return request(`/documents/${id}`, { token })
}

// Tạo tài liệu + nhận link upload: { name, mimeType, sizeBytes } -> { document, upload: { url, headers } }
export function createDocument(token, data) {
  return request('/documents', { token, method: 'POST', body: data })
}

// Báo đã tải xong: backend kiểm tra file thật rồi đưa vào hàng đợi xử lý
export function completeDocument(token, id) {
  return request(`/documents/${id}/complete`, { token, method: 'POST' })
}

// Sửa: { name?, folder?, tags?, pinned? }
export function updateDocument(token, id, changes) {
  return request(`/documents/${id}`, { token, method: 'PATCH', body: changes })
}

export function deleteDocument(token, id) {
  return request(`/documents/${id}`, { token, method: 'DELETE' })
}

// Nội dung văn bản của một trang: { page: { number, text }, pageCount }
export function getDocumentPage(token, id, page) {
  return request(`/documents/${id}/pages/${page}`, { token })
}

// Link tạm để xem/tải file gốc: { url }
export function getDocumentFileUrl(token, id) {
  return request(`/documents/${id}/file`, { token })
}

// Tải file lên thẳng Storage bằng link PUT backend cấp (không qua backend). onProgress(percent) để hiện thanh tiến độ.
export function uploadToSignedUrl(url, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', mimeType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Tải file lên thất bại. Vui lòng thử lại.'))
    xhr.onerror = () => reject(new Error('Lỗi mạng khi tải file lên. Kiểm tra kết nối rồi thử lại.'))
    xhr.send(file)
  })
}

// ---------- Câu hỏi + AI (Phase 3) ----------

// AI credits còn lại: { period, limit (hạn mức ngày), used, reserved, remaining, window, resetsAt, week: { limit, used, reserved, remaining, resetsAt } }
export function getCredits(token) {
  return request('/questions/credits', { token })
}

export function listTopics(token) {
  return request('/topics', { token })
}

// { subject, chapter, name } -> { topic } (đã có chủ đề y hệt thì trả lại chủ đề cũ)
export function createTopic(token, data) {
  return request('/topics', { token, method: 'POST', body: data })
}

// Xóa chủ đề (chỉ được khi không còn câu hỏi nào thuộc chủ đề; ngược lại backend trả 409)
export function deleteTopic(token, id) {
  return request(`/topics/${id}`, { token, method: 'DELETE' })
}

// Tạo job sinh câu hỏi: { documentId, topicId, count, types, pageFrom?, pageTo? } -> { jobId, credits }
export function generateQuestions(token, data) {
  return request('/questions/generate', { token, method: 'POST', body: data })
}

// Tiến độ job: { job: { id, status: queued|running|done|failed, progress, error, result } }
export function getJob(token, jobId) {
  return request(`/questions/jobs/${jobId}`, { token })
}

// Danh sách câu hỏi của tôi (kèm đáp án). filters: { topicId?, documentId?, jobId?, reviewStatus? }
export function listQuestions(token, filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()
  return request(`/questions${qs ? `?${qs}` : ''}`, { token })
}

// Nút "Xem nguồn": { source: { documentId, pageNumber, chunkId, text } }
export function getQuestionSource(token, id) {
  return request(`/questions/${id}/source`, { token })
}

// Sửa tay: { stem?, options?, correct?, alternatives?, explanation?, topicId? } (sửa xong về trạng thái nháp)
export function updateQuestion(token, id, changes) {
  return request(`/questions/${id}`, { token, method: 'PATCH', body: changes })
}

export function approveQuestion(token, id) {
  return request(`/questions/${id}/approve`, { token, method: 'POST' })
}

// Duyệt tối đa 50 câu một lần -> { approved, skipped }
export function approveManyQuestions(token, ids) {
  return request('/questions/approve-many', { token, method: 'POST', body: { ids } })
}

export function deleteQuestion(token, id) {
  return request(`/questions/${id}`, { token, method: 'DELETE' })
}

// Nhập đề có sẵn: { fileName, fileBase64, topicId, confirm? } -> xem trước (không confirm) hoặc lưu (confirm: true)
export function importQuestions(token, data) {
  return request('/questions/import', { token, method: 'POST', body: data })
}

// Tải file mẫu nhập đề ('xlsx' | 'docx') -> Blob
export async function downloadImportSample(token, format) {
  const res = await fetch(`${BASE_URL}/questions/import/sample/${format}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Không tải được file mẫu. Vui lòng thử lại.')
  return res.blob()
}

// Bản tóm tắt đã lưu (miễn phí): { summary: { overview, points: [{ text, pageNumber, chunkId }], createdAt } | null }
export function getSummary(token, id) {
  return request(`/documents/${id}/summary`, { token })
}

// Tạo tóm tắt mới (tốn credits). force=true: tóm tắt lại dù đã có bản lưu.
export function createSummary(token, id, force = false) {
  return request(`/documents/${id}/summary`, { token, method: 'POST', body: force ? { force: true } : {} })
}

// Hỏi đáp: { found, answer, sources: [{ chunkId, pageNumber, text }] }
export function askDocument(token, id, question) {
  return request(`/documents/${id}/ask`, { token, method: 'POST', body: { question } })
}

// ---------- Quiz (Phase 4) ----------

// Danh sách quiz của tôi: { quizzes: [{ id, title, questionCount, settings, currentVersion, hasUnpublishedChanges, ... }] }
export function listQuizzes(token) {
  return request('/quizzes', { token })
}

// Chi tiết bản nháp: { quiz: { ..., questions: [{ id, type, stem, ... }] } }
export function getQuiz(token, id) {
  return request(`/quizzes/${id}`, { token })
}

// { title, description?, questionIds?, settings? } -> { quiz }
export function createQuiz(token, data) {
  return request('/quizzes', { token, method: 'POST', body: data })
}

// Sửa bản nháp (không đụng tới các version đã publish)
export function updateQuiz(token, id, changes) {
  return request(`/quizzes/${id}`, { token, method: 'PATCH', body: changes })
}

export function deleteQuiz(token, id) {
  return request(`/quizzes/${id}`, { token, method: 'DELETE' })
}

// Publish: chụp bản nháp thành version mới bất biến -> { version, quiz }
export function publishQuiz(token, id) {
  return request(`/quizzes/${id}/publish`, { token, method: 'POST' })
}

export function listQuizVersions(token, id) {
  return request(`/quizzes/${id}/versions`, { token })
}

// Nội dung một version (không có đáp án)
export function getQuizVersion(token, id, version) {
  return request(`/quizzes/${id}/versions/${version}`, { token })
}

// Sao chép thành quiz mới: từ bản nháp hiện tại, hoặc từ một version nếu có `version` -> { quiz, dropped }
export function forkQuiz(token, id, version) {
  return request(`/quizzes/${id}/fork`, { token, method: 'POST', body: version ? { version } : {} })
}

// ---------- Làm bài (Phase 4) ----------
// Đáp án đúng không bao giờ có trong đề; chỉ xem được sau khi nộp (getAttemptResult).
// Câu trả lời: single = số (index gốc), multi = mảng số, truefalse = true (Đúng) / false (Sai), fill/short = chuỗi, null = xóa.

// Bắt đầu (hoặc tiếp tục lượt đang dở): { attempt, questions, serverNow, resumed }
export function startAttempt(token, quizId, version) {
  return request('/attempts', { token, method: 'POST', body: version ? { quizId, version } : { quizId } })
}

// Mở lại một lượt (tải lại trang): { attempt, questions (null nếu đã nộp), serverNow }
export function getAttempt(token, id) {
  return request(`/attempts/${id}`, { token })
}

// Lưu nháp: chỉ gửi các câu vừa đổi -> { savedAt, rejected }. Quá giờ thì backend trả 409 code 'time-up'.
// confidence (tuỳ chọn): { [questionId]: 'sure' | 'unsure' | 'guess' | null }; spent (tuỳ chọn): { [questionId]: ms cộng dồn }
export function saveAttemptAnswers(token, id, answers, confidence, spent) {
  const body = {}
  if (answers && Object.keys(answers).length) body.answers = answers
  if (confidence && Object.keys(confidence).length) body.confidence = confidence
  if (spent && Object.keys(spent).length) body.spent = spent
  return request(`/attempts/${id}/answers`, { token, method: 'PUT', body })
}

// Nộp bài (có thể kèm câu trả lời, mức tự tin và thời gian cuối). Nộp lại bài đã nộp trả lại kết quả cũ -> { already, submitReason, result }
export function submitAttempt(token, id, answers, confidence, spent) {
  const body = {}
  if (answers) body.answers = answers
  if (confidence) body.confidence = confidence
  if (spent) body.spent = spent
  return request(`/attempts/${id}/submit`, { token, method: 'POST', body })
}

// Xem lại sau khi nộp: { attempt, review: [{ id, type, stem, options, given, correct, status, explanation, topicId, confidence, changes, spentMs, errorType }],
//   confidenceSummary: { rated, levels: { sure|unsure|guess: { correct, wrong } }, sureWrong, guessCorrect },
//   errorSummary: { timeout, guess, careless, changed, misconception, knowledge: số câu } (gợi ý theo luật, không phải kết luận),
//   topics: [{ topicId, name, chapter, subject, correct, wrong, unanswered, total }] }
export function getAttemptResult(token, id) {
  return request(`/attempts/${id}/result`, { token })
}

// Lịch sử lượt làm của tôi (tuỳ chọn lọc theo quiz)
export function listAttempts(token, quizId) {
  return request(`/attempts${quizId ? `?quizId=${encodeURIComponent(quizId)}` : ''}`, { token })
}

// Ghi sự kiện chống gian lận: 'tab_hidden' | 'tab_visible' | 'window_blur' | 'window_focus' | 'copy' | 'paste'. Lỗi bị bỏ qua.
export async function logAttemptEvent(token, id, type) {
  try {
    await request(`/attempts/${id}/events`, { token, method: 'POST', body: { type } })
  } catch {
    // ghi nhận là phụ, không làm gián đoạn bài làm
  }
}

// ---------- Phòng làm bài (Phase 4) ----------
// Token dùng chung cho tài khoản và khách: khách truyền chuỗi 'Guest <token>' (xem request).

// Tạo phiên khách (không cần tài khoản): -> { token, guest: { id, displayName, expiresAt } }. Token chỉ trả về lần này.
export function createGuestSession(displayName) {
  return request('/guest-sessions', { method: 'POST', body: { displayName } })
}

// Chủ quiz mở phòng từ quiz đã publish -> { room }. options: { maxParticipants?, mode?: 'standard' | 'warmup' | 'exit' }
export function createRoom(token, quizId, options = {}) {
  const body = { quizId }
  if (options.maxParticipants) body.maxParticipants = options.maxParticipants
  if (options.mode && options.mode !== 'standard') body.mode = options.mode
  return request('/rooms', { token, method: 'POST', body })
}

// Các phòng của tôi (chủ phòng) -> { rooms }
export function listMyRooms(token) {
  return request('/rooms/mine', { token })
}

// Vào phòng bằng mã -> { room, rejoined, me: { displayName } }
export function joinRoom(token, code) {
  return request('/rooms/join', { token, method: 'POST', body: { code } })
}

// Trạng thái phòng (màn chờ hỏi định kỳ). Chủ phòng: { role: 'host', room, participants, counts }. Người tham gia: { role: 'participant', room, me }
export function getRoom(token, code) {
  return request(`/rooms/${code}`, { token })
}

export function startRoom(token, code) {
  return request(`/rooms/${code}/start`, { token, method: 'POST' })
}

// Kết thúc (hoặc hủy) phòng: các lượt đang dở được nộp tự động -> { room, settled }
export function endRoom(token, code) {
  return request(`/rooms/${code}/end`, { token, method: 'POST' })
}

// Bắt đầu (hoặc tiếp tục) làm bài trong phòng đang chạy: { attempt, questions, serverNow, resumed }
export function startRoomAttempt(token, code) {
  return request('/attempts/room', { token, method: 'POST', body: { code } })
}

// ---------- Ôn tập (Phase 5) ----------
// Sổ lỗi sai + lịch ôn 1 -> 3 -> 7 ngày. Chỉ dùng được với tài khoản (khách chưa có sổ).

// Tóm tắt nhẹ cho Trang chủ: { open, due, mastered, nextDueAt, serverNow }
export function getReviewSummary(token) {
  return request('/review/summary', { token })
}

// Sổ lỗi sai: status = 'open' (mặc định) | 'mastered'
// -> { mistakes: [{ id, type, stem, options, topicName, errorType, wrongCount, stage, nextReviewAt, topWrong: { index, count, text } | null, correct, alternatives, explanation }],
//      summary: { total, byErrorType, weakTopics: [{ topicId, name, mistakes }] } | null }
export function listMistakes(token, status = 'open') {
  return request(`/review/mistakes?status=${status}`, { token })
}

// Lấy câu để ôn (không có đáp án). scope: 'due' (mặc định, chỉ câu đến hạn) | 'open' (cả câu chưa đến hạn) -> { questions }
export function getReviewQuestions(token, { scope = 'due', limit = 10, subject = '' } = {}) {
  const subjectQuery = subject ? `&subject=${encodeURIComponent(subject)}` : ''
  return request(`/review/due?scope=${scope}&limit=${limit}${subjectQuery}`, { token })
}

// Các môn có câu đang ôn: { subjects: [{ subject, open, due }] }, môn nhiều câu đến hạn nhất lên đầu. Dùng cho bộ lọc theo môn ở màn Ôn tập.
export function getReviewSubjects(token) {
  return request('/review/subjects', { token })
}

// Chấm câu vừa ôn và cập nhật lịch: answers { [id]: giá trị }, confidence { [id]: 'sure' | 'unsure' | 'guess' } (tuỳ chọn)
// -> { items: [{ id, status: 'correct' | 'wrong', given, correct, alternatives, explanation, stage, mastered, nextReviewAt }], summary }
export function gradeReview(token, answers, confidence) {
  const body = { answers }
  if (confidence && Object.keys(confidence).length) body.confidence = confidence
  return request('/review/grade', { token, method: 'POST', body })
}

// Luyện phần yếu: bộ câu luyện cho một chủ đề (câu từng sai + câu đã duyệt trong ngân hàng của bạn), không có đáp án
// -> { questions } cùng dạng getReviewQuestions; câu từ ngân hàng có fresh: true và stage: null. Chấm bằng gradeReview (câu sai tự vào sổ lỗi sai).
export function getPracticeQuestions(token, { topicId, limit = 10 }) {
  return request(`/review/practice?topicId=${encodeURIComponent(topicId)}&limit=${limit}`, { token })
}

// Nhờ AI soạn câu luyện mới từ các câu từng sai của chủ đề (bám đoạn tài liệu nguồn). Tốn AI credits: 1 credit = 1 câu, hoàn phần không dùng.
// -> { jobId, credits } rồi hỏi tiến độ bằng getJob(token, jobId); job xong thì getPracticeQuestions có thêm câu mới (câu có unreviewed: true).
// Lỗi: 402 code 'quota-credits' (hết credits, có resetsAt), 409 'no-mistakes' (chưa có câu sai ở chủ đề), 429 'too-many-jobs'.
export function generatePractice(token, { topicId, count = 5 }) {
  return request('/review/practice/generate', { token, method: 'POST', body: { topicId, count } })
}

// Bản đồ kiến thức: mức thành thạo từng chủ đề, tính trên 30 câu gần nhất (cần ≥ 5 câu mới xếp loại)
// -> { map: [{ subject, percent, level, sample, chapters: [{ chapter, percent, level, sample, topics: [{ topicId, name, percent, level: 'new' | 'weak' | 'learning' | 'strong', sample, answered, lastAt }] }] }],
//      weakest: [topic yếu nhất], counts: { new, weak, learning, strong } }
export function getMastery(token) {
  return request('/review/mastery', { token })
}

// Chủ đề đã ôn xong (mọi câu đã nắm, không còn câu đang ôn)
// -> { topics: [{ topicId ('_none' = câu không gắn chủ đề), name, chapter, subject, percent, level, questions, hard, wrongTotal, reviewTotal, hardest: [{ id, stem, wrongCount }] }] }
export function getFinishedTopics(token) {
  return request('/review/finished', { token })
}

// Hoàn thành chủ đề: lưu trữ các câu, không hiện nữa, tự xóa sau 90 ngày -> { archived }. Lỗi: 409 'not-finished', 404 'nothing-to-archive'.
export function completeFinishedTopic(token, topicId) {
  return request('/review/finished/complete', { token, method: 'POST', body: { topicId } })
}

// Ôn lại chủ đề: đưa câu về mốc đầu, đến hạn ngay. scope 'hard' (mặc định, chỉ câu khó) | 'all' -> { restarted }. Lỗi: 409 'no-hard', 404 'nothing-to-restart'.
export function restartFinishedTopic(token, topicId, scope = 'hard') {
  return request('/review/finished/restart', { token, method: 'POST', body: { topicId, scope } })
}

// ---------- Heatmap + chuyển kết quả khách (Phase 5) ----------

// Heatmap cho chủ phòng: { heatmap: { ready, submitted, needed, questions: [{ id, no, stem, topicId, answered, wrong, skipped, wrongRate, level: 'hot' | 'warm' | 'mild' | 'cool' | 'none', enough }],
//   topics: [{ topicId, name, subject, chapter, answered, wrong, wrongRate, level, enough }],
//   reviewPoints: [{ kind: 'topic' | 'question', title, detail, wrongRate, wrong, answered }] (tối đa 3) } }
// Chưa đủ 5 bài nộp thì ready = false và các danh sách rỗng.
export function getRoomHeatmap(token, code) {
  return request(`/rooms/${code}/heatmap`, { token })
}

// Khách vừa tạo tài khoản: chuyển các bài đã nộp lúc còn là khách sang tài khoản. token = token đăng nhập của tài khoản, guestToken = token phiên khách.
// -> { moved, unfinished }. Phiên khách hết hạn thì lỗi 404 với code 'guest-expired'.
export function claimGuestAttempts(token, guestToken) {
  return request('/attempts/claim-guest', { token, method: 'POST', body: { guestToken } })
}

// Ghi sự kiện analytics ('visit' | 'register'). Lỗi được bỏ qua để không ảnh hưởng người dùng.
export async function trackEvent(type, { token, meta } = {}) {
  try {
    await request('/events', { token, method: 'POST', body: { type, meta } })
  } catch {
    // analytics là phụ, không báo lỗi ra giao diện
  }
}
