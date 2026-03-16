/**
 * Interactive prompt buttons shown when Claude asks for user input.
 *
 * Supports two modes: single-select (click sends immediately) and
 * multi-select (toggle choices, then confirm). Permission prompts
 * (allow/deny/always-allow) get distinct color-coded styling.
 *
 * For AskUserQuestion with multiple questions, walks the user through
 * each question sequentially, collecting answers, then sends a JSON
 * answers map back via onSelect. The parent should set a `key` prop
 * tied to the requestId so the component remounts on new prompts.
 *
 * Rendered as a sticky bar above the input area.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { PromptOption, PromptQuestion } from '../types'

interface PromptButtonsProps {
  options: PromptOption[]
  question?: string | null
  multiSelect?: boolean
  promptType?: 'permission' | 'question' | null
  /** Full list of questions for multi-question AskUserQuestion prompts. */
  questions?: PromptQuestion[]
  /** Derived pattern for "Approve Pattern" button, e.g. "cat *". Only present for Bash permission prompts. */
  approvePattern?: string
  onSelect: (value: string | string[]) => void
  /** When true, uses larger tap targets for mobile. */
  isMobile?: boolean
}

/** Sticky prompt bar for permission approvals, single/multi-select questions, and multi-question AskUserQuestion flows. */
export function PromptButtons({ options, question, multiSelect, promptType, questions, approvePattern, onSelect, isMobile = false }: PromptButtonsProps) {
  const isPermission = promptType === 'permission'
  const btnPad = isMobile ? 'px-4 py-2.5 text-[16px] min-h-[34px]' : 'px-3 py-0.5 text-[13px]'

  // Auto-allow countdown for permission prompts
  const [timeLeft, setTimeLeft] = useState(15)

  // Multi-question flow state (reset by parent remounting via key prop)
  const isMultiQuestion = questions && questions.length > 1
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Determine the current question to display
  const currentQ = isMultiQuestion ? questions[questionIndex] : null
  const displayQuestion = currentQ ? currentQ.question : question
  const displayOptions = currentQ ? currentQ.options : options
  const displayMultiSelect = currentQ ? currentQ.multiSelect : multiSelect

  // Multi-question flow: each answer is recorded in `answers` keyed by question text.
  // After recording, the index advances to the next question and selection state resets.
  // When the last question is answered, all answers are serialized as a JSON map and
  // sent back to the parent via onSelect. For single questions this is a pass-through.
  const handleSingleAnswer = useCallback((value: string) => {
    if (!isMultiQuestion || !currentQ) {
      onSelect(value)
      return
    }
    const nextAnswers = { ...answers, [currentQ.question]: value }
    if (questionIndex + 1 < questions.length) {
      // More questions remain — save answer and advance to the next one
      setAnswers(nextAnswers)
      setQuestionIndex(questionIndex + 1)
      setSelected(new Set())
    } else {
      // Final question answered — send the complete answers map
      onSelect(JSON.stringify(nextAnswers))
    }
  }, [isMultiQuestion, currentQ, answers, questionIndex, questions, onSelect])

  // Ref to latest handleSingleAnswer so the interval closure always calls the current version
  const handleSingleAnswerRef = useRef(handleSingleAnswer)
  handleSingleAnswerRef.current = handleSingleAnswer

  // Auto-allow countdown: fires only for permission prompts that support "Always Allow".
  // Tools like ExitPlanMode deliberately omit "Always Allow" to require explicit confirmation.
  useEffect(() => {
    if (!isPermission) return
    const allowOption = options.find(o => o.value === 'allow')
    if (!allowOption) return
    const hasAlwaysAllow = options.some(o => o.value === 'always_allow')
    if (!hasAlwaysAllow) return // Requires explicit user decision — no auto-allow

    let remaining = 15
    const interval = setInterval(() => {
      remaining--
      setTimeLeft(remaining) // eslint-disable-line react-hooks/set-state-in-effect -- async timer callback
      if (remaining <= 0) {
        clearInterval(interval)
        handleSingleAnswerRef.current('allow')
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isPermission, options])

  const handleMultiAnswer = useCallback((values: string[]) => {
    const joined = values.join(', ')
    if (!isMultiQuestion || !currentQ) {
      onSelect(values)
      return
    }
    const nextAnswers = { ...answers, [currentQ.question]: joined }
    if (questionIndex + 1 < questions.length) {
      setAnswers(nextAnswers)
      setQuestionIndex(questionIndex + 1)
      setSelected(new Set())
    } else {
      onSelect(JSON.stringify(nextAnswers))
    }
  }, [isMultiQuestion, currentQ, answers, questionIndex, questions, onSelect])

  // Progress indicator for multi-question
  const progressLabel = isMultiQuestion
    ? `(${questionIndex + 1}/${questions.length})`
    : null

  if (displayMultiSelect) {
    const toggle = (value: string) => {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      })
    }

    const confirm = () => {
      handleMultiAnswer(Array.from(selected))
      setSelected(new Set())
    }

    return (
      <div className={`border-t px-3 py-2 ${isPermission ? 'border-warning-9/50 bg-warning-11/30' : 'border-neutral-10 bg-neutral-11'}`}>
        {displayQuestion && (
          <p className={`text-[13px] mb-1.5 ${isPermission ? 'text-warning-4' : 'text-neutral-3'}`}>
            {progressLabel && <span className="text-neutral-5 mr-1">{progressLabel}</span>}
            {displayQuestion}
          </p>
        )}
        <div className={`flex flex-wrap items-center ${isMobile ? 'gap-2.5' : 'gap-1.5'}`}>
          {displayOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => toggle(opt.value)}
              title={opt.description}
              className={`rounded-full border ${btnPad} transition-colors ${
                selected.has(opt.value)
                  ? 'border-primary-6 bg-primary-9 text-primary-3'
                  : 'border-neutral-8 bg-neutral-10 text-neutral-2 hover:border-primary-7 hover:bg-neutral-9 hover:text-neutral-1'
              }`}
            >
              {opt.label}
            </button>
          ))}
          {selected.size > 0 && (
            <button
              onClick={confirm}
              className={`rounded-full border border-primary-7 bg-primary-9 ${btnPad} text-primary-3 hover:bg-primary-8 transition-colors`}
            >
              Confirm ({selected.size})
            </button>
          )}
        </div>
      </div>
    )
  }

  // Single-select: click sends immediately
  return (
    <div className={`border-t px-3 py-2 ${isPermission ? 'border-warning-9/50 bg-warning-11/30' : 'border-neutral-10 bg-neutral-11'}`}>
      {displayQuestion && (
        <p className={`text-[13px] mb-1.5 ${isPermission ? 'text-warning-4' : 'text-neutral-3'}`}>
          {progressLabel && <span className="text-neutral-5 mr-1">{progressLabel}</span>}
          {displayQuestion}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {displayOptions.map((opt) => {
          const isAllow = isPermission && opt.value === 'allow'
          const isAlwaysAllow = isPermission && opt.value === 'always_allow'
          const alwaysAllowTitle = isAlwaysAllow
            ? (approvePattern ? `Auto-approve: ${approvePattern}` : 'Auto-approve this exact command')
            : undefined
          const isDeny = isPermission && opt.value === 'deny'
          let btnClass = `rounded-full border ${btnPad} transition-colors `
          if (isAllow) {
            btnClass += 'border-success-7 bg-success-10/50 text-success-4 hover:bg-success-9/50'
          } else if (isAlwaysAllow) {
            btnClass += 'border-primary-7 bg-primary-10/50 text-primary-4 hover:bg-primary-9/50'
          } else if (isDeny) {
            btnClass += 'border-error-7 bg-error-10/50 text-error-4 hover:bg-error-9/50'
          } else {
            btnClass += 'border-neutral-8 bg-neutral-10 text-neutral-2 hover:border-primary-7 hover:bg-neutral-9 hover:text-neutral-1'
          }
          return (
            <button
              key={opt.value}
              onClick={() => handleSingleAnswer(opt.value)}
              title={alwaysAllowTitle ?? opt.description}
              className={btnClass}
            >
              {opt.label}{isAllow && options.some(o => o.value === 'always_allow') && ` (${timeLeft}s)`}
            </button>
          )
        })}
      </div>
    </div>
  )
}
