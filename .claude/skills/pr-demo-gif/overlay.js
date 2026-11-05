// Demo overlay for screen recordings. Paste this whole file as the `function`
// argument of chrome-devtools `evaluate_script` once per page load, before
// starting the screencast. It is idempotent: running it again is harmless.
//
// It installs, on `window`:
//   caption(text)  big caption at the top of the page; caption('') hides it
//   pause(ms)      promise-based sleep, for pacing inside one script
//   tap(el)        scrolls el into view, shows a click ping on it, then clicks
//
// and a key badge: special keys and modifier combos (Shift+Tab, Ctrl+C, Enter,
// Escape, arrows, ...) light up as keycaps above the bottom of the page for
// about a second. Plain typing (letters without modifiers) is not shown.
//
// All of it survives client-side navigation; a full reload removes it.
() => {
  if (window.__demoOverlay) return 'already installed'
  window.__demoOverlay = true

  const style = document.createElement('style')
  style.textContent = `
    #__demo_caption { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      background: rgba(18,18,18,.9); color: #fff; font: 700 26px/1.3 system-ui, sans-serif; padding: 14px 26px;
      border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.3); max-width: 88vw; text-align: center;
      pointer-events: none; display: none; }
    #__demo_keys { position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%) scale(.9); z-index: 2147483647;
      display: flex; gap: 10px; align-items: center; opacity: 0; transition: opacity .15s, transform .15s;
      pointer-events: none; font: 700 28px system-ui, sans-serif; }
    #__demo_keys.on { opacity: 1; transform: translateX(-50%) scale(1); }
    #__demo_keys kbd { font: 700 28px ui-monospace, monospace; background: #222; color: #fff; border: 2px solid #555;
      border-bottom-width: 5px; border-radius: 10px; padding: 8px 18px; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
    #__demo_keys span { color: #222; text-shadow: 0 0 6px #fff; }
    .__demo_click { position: fixed; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; border: 4px solid rgba(220,60,40,.9); pointer-events: none;
      animation: __demo_ping .7s ease-out forwards; }
    @keyframes __demo_ping { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }`
  document.head.appendChild(style)

  const pause = (ms) => new Promise(r => setTimeout(r, ms))
  window.pause = pause

  window.caption = (text) => {
    let el = document.getElementById('__demo_caption')
    if (!el) { el = document.createElement('div'); el.id = '__demo_caption'; document.body.appendChild(el) }
    el.textContent = text
    el.style.display = text ? 'block' : 'none'
  }

  const keys = document.createElement('div')
  keys.id = '__demo_keys'
  document.body.appendChild(keys)
  const NAMES = { ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Enter: '↵ Enter', Backspace: '⌫' }
  const MODS = [['metaKey', '⌘ Cmd'], ['ctrlKey', '⌃ Ctrl'], ['altKey', '⌥ Alt'], ['shiftKey', '⇧ Shift']]
  let hideTimer
  document.addEventListener('keydown', (e) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
    const mods = MODS.filter(([k]) => e[k]).map(([, label]) => label)
    const special = e.key.length > 1 || e.key === ' '
    // Plain typing stays off-screen; Shift+letter is just a capital letter.
    if (!special && (mods.length === 0 || (mods.length === 1 && e.shiftKey))) return
    const key = NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
    keys.innerHTML = [...mods, key].map(k => `<kbd>${k}</kbd>`).join('<span>+</span>')
    keys.classList.add('on')
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => keys.classList.remove('on'), 1100)
  }, true)

  window.tap = async (el) => {
    if (!el) return false
    el.scrollIntoView({ block: 'nearest' })
    await pause(150)
    const r = el.getBoundingClientRect()
    const ping = document.createElement('div')
    ping.className = '__demo_click'
    ping.style.left = `${r.left + r.width / 2}px`
    ping.style.top = `${r.top + r.height / 2}px`
    document.body.appendChild(ping)
    setTimeout(() => ping.remove(), 800)
    await pause(350)
    el.click()
    return true
  }
  return 'installed'
}
