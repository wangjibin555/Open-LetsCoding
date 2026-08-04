// D18 多选提问卡：模型调 AskUserQuestion 时渲染，收集用户选择回填 SDK。
// 单选=radio、多选=checkbox，每题附「其他（自定义）」自填项；全部答完才可提交。
import { useState } from 'react'
import type { QuestionRequestPayload } from '../../shared/ipc'

const OTHER = '__other__'

export default function QuestionCard({
  question,
  onSubmit,
  onCancel
}: {
  question: QuestionRequestPayload
  onSubmit: (answers: Record<string, string | string[]>) => void
  onCancel: () => void
}): React.JSX.Element {
  const qs = question.questions
  // 每题选中的 option label 集合（单选至多 1）；「其他」文本单独存
  const [sel, setSel] = useState<Record<number, string[]>>({})
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})

  const pickSingle = (i: number, label: string): void => {
    setSel((s) => ({ ...s, [i]: [label] }))
    setOtherOn((o) => ({ ...o, [i]: false }))
  }
  const toggleMulti = (i: number, label: string): void => {
    setSel((s) => {
      const cur = s[i] ?? []
      return { ...s, [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }
  const pickSingleOther = (i: number): void => {
    setSel((s) => ({ ...s, [i]: [] }))
    setOtherOn((o) => ({ ...o, [i]: true }))
  }
  const toggleMultiOther = (i: number): void => setOtherOn((o) => ({ ...o, [i]: !o[i] }))

  const answered = (i: number): boolean => {
    const hasOther = !!otherOn[i] && !!otherText[i]?.trim()
    return (sel[i]?.length ?? 0) > 0 || hasOther
  }
  const allAnswered = qs.every((_, i) => answered(i))

  const submit = (): void => {
    if (!allAnswered) return
    const answers: Record<string, string | string[]> = {}
    qs.forEach((q, i) => {
      const labels = sel[i] ?? []
      const other = otherOn[i] && otherText[i]?.trim() ? otherText[i].trim() : null
      if (q.multiSelect) {
        answers[q.question] = other ? [...labels, other] : labels
      } else {
        answers[q.question] = other ?? labels[0]
      }
    })
    onSubmit(answers)
  }

  return (
    <div className="q-card">
      <div className="q-head">◆ 需要你的选择</div>
      {qs.map((q, i) => (
        <div className="q-block" key={i}>
          <div className="q-title">
            {q.header && <span className="q-chip">{q.header}</span>}
            <span>{q.question}</span>
            {q.multiSelect && <span className="q-multi">可多选</span>}
          </div>
          <div className="q-opts">
            {q.options.map((opt) => {
              const on = q.multiSelect
                ? (sel[i] ?? []).includes(opt.label)
                : (sel[i] ?? [])[0] === opt.label && !otherOn[i]
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`q-opt${on ? ' on' : ''}`}
                  onClick={() => (q.multiSelect ? toggleMulti(i, opt.label) : pickSingle(i, opt.label))}
                >
                  <span className={`q-mark${q.multiSelect ? ' box' : ''}`}>{on ? '✓' : ''}</span>
                  <span className="q-opt-body">
                    <span className="q-opt-label">{opt.label}</span>
                    {opt.description && <span className="q-opt-desc">{opt.description}</span>}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className={`q-opt${otherOn[i] ? ' on' : ''}`}
              onClick={() => (q.multiSelect ? toggleMultiOther(i) : pickSingleOther(i))}
            >
              <span className={`q-mark${q.multiSelect ? ' box' : ''}`}>{otherOn[i] ? '✓' : ''}</span>
              <span className="q-opt-body">
                <span className="q-opt-label">其他（自定义）</span>
              </span>
            </button>
            {otherOn[i] && (
              <input
                className="q-other"
                autoFocus
                value={otherText[i] ?? ''}
                onChange={(e) => setOtherText((t) => ({ ...t, [i]: e.target.value }))}
                placeholder="输入你的回答…"
              />
            )}
          </div>
        </div>
      ))}
      <div className="q-acts">
        <button className="mini acc" disabled={!allAnswered} onClick={submit}>
          提交
        </button>
        <button className="mini" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
