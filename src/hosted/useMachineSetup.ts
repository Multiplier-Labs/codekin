/**
 * Machine list + "add a computer" state for the hosted app.
 *
 * One hook owns the machine list, the install command this tab generated, and
 * the polling that notices when that command has been run. It is shared by
 * the first-run "Connect your computer" surface and the Machines section of
 * Settings, so a command shown on one survives a switch to the other.
 *
 * The pairing token lives only in this hook's state: the relay never returns
 * it again, and it must not reach localStorage, sessionStorage or the URL. A
 * reload therefore loses it — the list still shows the pending machine, and
 * the UI offers Regenerate instead.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  fetchMachines,
  precreatePairing,
  removeMachine,
  pairingErrorMessage,
  RelayRequestError,
  isUsableMachine,
  type Machine,
  type Pairing,
} from './machines'

/** How often the list is re-read while something is expected to change. */
export const SETUP_POLL_MS = 2500

export type SetupStep = 'waiting' | 'paired' | 'online'

export interface MachineSetup {
  /** null until the first successful load. */
  machines: Machine[] | null
  /** The most recent list request failed (earlier data, if any, is kept). */
  loadFailed: boolean
  /** When the list was last loaded (epoch ms) — for "expires in" labels. */
  loadedAt: number
  refresh: () => Promise<void>
  /** Install command generated in this tab, if any. */
  pairing: Pairing | null
  /** The machine the displayed command created, once the list includes it. */
  pairingMachine: Machine | null
  /** Where the displayed command's machine is in setup. */
  step: SetupStep | null
  generating: boolean
  /** Why the last generate/regenerate failed; shown even over an older command. */
  generateError: string | null
  /** Mint a command; `replaceMachineId` regenerates a still-unclaimed machine's. */
  generate: (replaceMachineId?: string) => Promise<void>
  /** Forget the displayed command (after success — it has been used). */
  dismissPairing: () => void
  /** Delete a machine: cancels a pending setup, or removes a paired machine. */
  remove: (machineId: string) => Promise<boolean>
  /** Why the last remove/cancel failed. */
  removeError: string | null
}

export function setupStep(machine: Machine | null): SetupStep {
  if (!machine || machine.setupPending) return 'waiting'
  return machine.status === 'offline' ? 'paired' : 'online'
}

export function useMachineSetup({ pollWhileEmpty = false }: {
  /** Keep polling while the user has no usable machine (the first-run surface). */
  pollWhileEmpty?: boolean
} = {}): MachineSetup {
  const [machines, setMachines] = useState<Machine[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadedAt, setLoadedAt] = useState(0)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Responses can arrive out of order (a slow poll after a fast Retry); only
  // the newest request may write the list.
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const list = await fetchMachines()
      if (!mounted.current || seq !== requestSeq.current) return
      setMachines(list)
      setLoadedAt(Date.now())
      setLoadFailed(false)
    } catch {
      if (!mounted.current || seq !== requestSeq.current) return
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const pairingMachine = pairing ? machines?.find(m => m.id === pairing.machineId) ?? null : null
  const step = pairing ? setupStep(pairingMachine) : null

  const anyPending = machines?.some(m => m.setupPending) ?? false
  const noUsable = machines === null || !machines.some(isUsableMachine)
  const shouldPoll =
    (pairing !== null && step !== 'online') || anyPending || (pollWhileEmpty && noUsable)

  useEffect(() => {
    if (!shouldPoll) return
    const timer = setInterval(() => {
      // A hidden tab does not need the answer; visibilitychange catches up.
      if (document.hidden) return
      void refresh()
    }, SETUP_POLL_MS)
    return () => { clearInterval(timer) }
  }, [shouldPoll, refresh])

  // Coming back to the tab — typically from the terminal that just ran the
  // command — is exactly when the list is most likely to have changed.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) void refresh() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const generate = useCallback(async (replaceMachineId?: string) => {
    setGenerating(true)
    setGenerateError(null)
    try {
      let next
      try {
        next = await precreatePairing(replaceMachineId ? { replaceMachineId } : {})
      } catch (err) {
        // The pending machine being replaced was already swept (its command
        // expired): there is nothing to replace, so start a fresh one.
        if (!(replaceMachineId && err instanceof RelayRequestError && err.code === 'machine_not_found')) throw err
        next = await precreatePairing()
      }
      if (!mounted.current) return
      setPairing(next)
    } catch (err) {
      // An older command stays on screen (it may still be valid); the error
      // is shown next to it rather than replacing it.
      if (mounted.current) setGenerateError(pairingErrorMessage(err))
    } finally {
      if (mounted.current) setGenerating(false)
    }
    void refresh()
  }, [refresh])

  const dismissPairing = useCallback(() => {
    setPairing(null)
    setGenerateError(null)
  }, [])

  const remove = useCallback(async (machineId: string) => {
    setRemoveError(null)
    try {
      await removeMachine(machineId)
    } catch {
      if (mounted.current) setRemoveError('Could not remove it. Try again.')
      return false
    }
    if (!mounted.current) return true
    setPairing(p => (p?.machineId === machineId ? null : p))
    setMachines(list => list?.filter(m => m.id !== machineId) ?? list)
    void refresh()
    return true
  }, [refresh])

  return {
    machines,
    loadFailed,
    loadedAt,
    refresh,
    pairing,
    pairingMachine,
    step,
    generating,
    generateError,
    generate,
    dismissPairing,
    remove,
    removeError,
  }
}
