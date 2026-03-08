/**
 * Floating task list popup — top-right corner of the chat area.
 *
 * Shows active tasks with status indicators. Starts as a compact progress pill,
 * expands on click. Auto-shows when tasks arrive, auto-hides after all complete.
 * Dismissable via X button.
 */

import { useEffect, useRef, useState } from 'react'
import { IconX, IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import type { TaskItem } from '../types'

interface Props {
  tasks: TaskItem[]
}

export function TodoPanel({ tasks }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const prevCountRef = useRef(0)
  const hadActiveTaskRef = useRef(false)
  const prevCompletedRef = useRef(0)
  const taskRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const completed = tasks.filter(t => t.status === 'completed').length
  const allDone = tasks.length > 0 && completed === tasks.length

  // Auto-expand when new tasks appear
  useEffect(() => {
    if (tasks.length > prevCountRef.current) {
      setExpanded(true) // eslint-disable-line react-hooks/set-state-in-effect -- auto-expand on new tasks
      setDismissed(false) // eslint-disable-line react-hooks/set-state-in-effect -- un-dismiss on new tasks
    }
    prevCountRef.current = tasks.length
  }, [tasks.length])

  // Track if we ever saw a non-completed task (distinguishes live vs restore)
  useEffect(() => {
    if (!allDone && tasks.length > 0) {
      hadActiveTaskRef.current = true
    }
  }, [tasks, allDone])

  // Auto-dismiss after all tasks complete
  useEffect(() => {
    if (allDone) {
      const delay = hadActiveTaskRef.current ? 10000 : 0
      const timer = setTimeout(() => setDismissed(true), delay)
      return () => clearTimeout(timer)
    }
    setDismissed(false) // eslint-disable-line react-hooks/set-state-in-effect -- reset dismissed when tasks become active
  }, [allDone])

  // Auto-scroll to first non-completed task when completed count increases
  useEffect(() => {
    if (completed > prevCompletedRef.current && !allDone) {
      const firstPending = tasks.find(t => t.status !== 'completed')
      if (firstPending) {
        const el = taskRefs.current.get(firstPending.id)
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
    prevCompletedRef.current = completed
  }, [completed, allDone, tasks])

  if (tasks.length === 0 || dismissed) return null

  // Collapsed pill view
  if (!expanded) {
    return (
      <div className="absolute top-3 right-3 z-20">
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 rounded-lg bg-neutral-9/90 backdrop-blur border border-neutral-8/60 px-2.5 py-1.5 shadow-lg hover:bg-neutral-8/90 transition-colors"
        >
          {!allDone && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-5 animate-pulse" />}
          <span className="text-[13px] font-semibold text-neutral-2">
            {completed}/{tasks.length}
          </span>
          <IconChevronDown size={14} className="text-neutral-4" />
        </button>
      </div>
    )
  }

  // Expanded card view
  return (
    <div className="absolute top-3 right-3 z-20 w-64 rounded-lg bg-neutral-9/90 backdrop-blur border border-neutral-8/60 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-8/40">
        <span className="text-[13px] font-semibold text-neutral-1 uppercase tracking-wider flex items-center gap-1.5">
          {!allDone && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-5 animate-pulse" />}
          Tasks
          <span className={`text-[13px] font-medium ml-1 ${allDone ? 'text-success-5' : 'text-neutral-5'}`}>
            {completed}/{tasks.length}
          </span>
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setExpanded(false)}
            className="rounded p-0.5 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-8/60 transition-colors"
            title="Collapse"
          >
            <IconChevronUp size={14} />
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded p-0.5 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-8/60 transition-colors"
            title="Dismiss"
          >
            <IconX size={14} />
          </button>
        </div>
      </div>

      {/* Task list */}
      <div className="flex flex-col gap-1 px-3 py-2 max-h-[50vh] overflow-y-auto">
        {tasks.map((task) => (
          <div
            key={task.id}
            ref={(el) => { if (el) taskRefs.current.set(task.id, el); else taskRefs.current.delete(task.id) }}
            className="flex items-start gap-2 text-[15px]"
          >
            {task.status === 'completed' ? (
              <span className="flex-shrink-0 text-success-5 text-[13px] mt-[3px]">&#10003;</span>
            ) : task.status === 'in_progress' ? (
              <span className="inline-block h-2 w-2 mt-[7px] rounded-full bg-primary-5 animate-pulse flex-shrink-0" />
            ) : (
              <span className="inline-block h-2 w-2 mt-[7px] rounded-full border border-neutral-5 flex-shrink-0" />
            )}
            <span className={task.status === 'completed' ? 'text-neutral-4 line-through' : 'text-neutral-2'}>
              {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
