/**
 * Encapsulates all prompt-related state for a chat session.
 *
 * Manages promptOptions, promptQuestion, multiSelect, promptRequestId,
 * promptType, promptQuestions, and approvePattern — extracted from
 * useChatSocket to reduce its state variable count.
 */

import { useState, useCallback } from 'react'
import type { PromptOption, PromptQuestion, WsServerMessage } from '../types'

export interface PromptState {
  promptOptions: PromptOption[] | null
  promptQuestion: string | null
  multiSelect: boolean
  promptRequestId: string | null
  promptType: 'permission' | 'question' | null
  promptQuestions: PromptQuestion[] | undefined
  approvePattern: string | undefined
}

const INITIAL_STATE: PromptState = {
  promptOptions: null,
  promptQuestion: null,
  multiSelect: false,
  promptRequestId: null,
  promptType: null,
  promptQuestions: undefined,
  approvePattern: undefined,
}

export function usePromptState() {
  const [state, setState] = useState<PromptState>(INITIAL_STATE)

  const clear = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  const setFromMessage = useCallback((msg: WsServerMessage & { type: 'prompt' }) => {
    setState({
      promptOptions: msg.options,
      promptQuestion: msg.question || null,
      multiSelect: msg.multiSelect ?? false,
      promptRequestId: msg.requestId ?? null,
      promptType: msg.promptType ?? null,
      promptQuestions: msg.questions,
      approvePattern: msg.approvePattern,
    })
  }, [])

  return { state, clear, setFromMessage }
}
