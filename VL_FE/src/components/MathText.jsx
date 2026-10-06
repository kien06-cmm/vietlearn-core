// Chức năng: hiển thị văn bản có công thức LaTeX viết trong dấu $...$ (vd: "Giải $x^2 + 1 = 0$"). Phần còn lại là chữ thường (an toàn, không chèn HTML).
import katex from 'katex'
import 'katex/dist/katex.min.css'

// $...$ : sau $ mở và trước $ đóng không được là khoảng trắng (tránh nhầm "giá 5$ và 10$" là công thức)
const MATH = /\$(?=\S)([^$\n]*?\S)\$/g

function renderMath(expr) {
  try {
    return katex.renderToString(expr, { throwOnError: false })
  } catch {
    return null
  }
}

export default function MathText({ text }) {
  const source = String(text ?? '')
  const parts = []
  let last = 0

  for (const m of source.matchAll(MATH)) {
    if (m.index > last) parts.push({ kind: 'text', value: source.slice(last, m.index) })
    const html = renderMath(m[1])
    parts.push(html ? { kind: 'math', value: html } : { kind: 'text', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < source.length) parts.push({ kind: 'text', value: source.slice(last) })

  return (
    <span className="math-text">
      {parts.map((p, i) =>
        p.kind === 'math' ? (
          // HTML này do KaTeX sinh ra từ công thức (đã thoát ký tự), không phải HTML thô của người dùng/AI
          <span key={i} dangerouslySetInnerHTML={{ __html: p.value }} />
        ) : (
          <span key={i}>{p.value}</span>
        )
      )}
    </span>
  )
}
