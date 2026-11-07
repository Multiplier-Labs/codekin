// Splash and error views for the desktop shell. The supervisor navigates here
// with ?view=status&status=… or ?view=error&code=…&message=…; buttons call the
// shell's retry / show_logs / quit commands. Text is set with textContent only.
(function () {
  const params = new URLSearchParams(location.search)
  const STATUS = {
    starting: 'Starting Codekin…',
    restarting: 'Restarting the Codekin server…',
    reconnecting: 'Lost contact with the Codekin service. Reconnecting…',
  }
  const TITLES = {
    service_stopped: 'The Codekin service stopped',
    data_newer: 'This app is older than your Codekin data',
    data_in_use: 'Another Codekin server is running',
    port_conflict: 'The Codekin port is taken',
    auth_error: "Codekin didn't accept this Mac's credential",
  }

  function invoke(cmd) {
    const tauri = window.__TAURI__
    if (tauri && tauri.core) return tauri.core.invoke(cmd).catch(function () {})
    return Promise.resolve()
  }

  if (params.get('view') === 'error') {
    const code = params.get('code') || 'unknown'
    document.getElementById('error').hidden = false
    document.getElementById('error-title').textContent = TITLES[code] || "Codekin couldn't start"
    document.getElementById('error-message').textContent = params.get('message') || ''
    document.getElementById('error-code').textContent = code
    const retry = document.getElementById('retry')
    retry.addEventListener('click', function () {
      retry.disabled = true
      document.getElementById('error').hidden = true
      document.getElementById('status').hidden = false
      invoke('retry')
    })
    document.getElementById('logs').addEventListener('click', function () { invoke('show_logs') })
    document.getElementById('quit').addEventListener('click', function () { invoke('quit') })
  } else {
    document.getElementById('status').hidden = false
    document.getElementById('status-text').textContent = STATUS[params.get('status')] || STATUS.starting
  }
})()
