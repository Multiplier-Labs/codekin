// Bundled pages of the desktop shell. The shell navigates here with
// ?view=…: status / error (supervisor), signin / waiting / claim (a hosted
// location's browser sign-in) and locations (the location manager). Buttons
// call the shell's commands. Text is set with textContent only.
(function () {
  const params = new URLSearchParams(location.search)
  const view = params.get('view')
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

  function invoke(cmd, args) {
    const tauri = window.__TAURI__
    if (tauri && tauri.core) return tauri.core.invoke(cmd, args)
    return Promise.reject(new Error('Not running in the Codekin app.'))
  }
  function quiet(cmd, args) { return invoke(cmd, args).catch(function () {}) }
  function $(id) { return document.getElementById(id) }
  function show(id) { $(id).hidden = false }
  function on(id, fn) { $(id).addEventListener('click', fn) }

  // The relay endpoint a claim may be posted to: https, or http on loopback.
  function claimAction(raw) {
    try {
      const u = new URL(raw)
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].indexOf(u.hostname) !== -1
      const ok = (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) &&
        u.pathname === '/api/auth/desktop/claim' && !u.search && !u.username
      return ok ? u.href : null
    } catch (e) {
      return null
    }
  }

  if (view === 'error') {
    const code = params.get('code') || 'unknown'
    show('error')
    $('error-title').textContent = TITLES[code] || "Codekin couldn't start"
    $('error-message').textContent = params.get('message') || ''
    $('error-code').textContent = code
    const retry = $('retry')
    on('retry', function () {
      retry.disabled = true
      $('error').hidden = true
      show('status')
      quiet('retry')
    })
    on('logs', function () { quiet('show_logs') })
    on('quit', function () { quiet('quit') })
  } else if (view === 'signin') {
    show('signin')
    $('signin-title').textContent = 'Sign in to ' + (params.get('name') || 'this location')
    $('signin-origin').textContent = params.get('origin') || ''
    if (params.get('error')) {
      $('signin-error').textContent = params.get('error')
      show('signin-error')
    }
    on('signin-start', function () { quiet('location_sign_in') })
    on('signin-this-mac', function () { quiet('location_switch', { id: null }) })
  } else if (view === 'waiting') {
    show('waiting')
    $('waiting-title').textContent = 'Waiting for your browser…'
    on('waiting-reopen', function () { quiet('location_sign_in_reopen') })
    on('waiting-cancel', function () { quiet('location_sign_in_cancel') })
  } else if (view === 'claim') {
    show('claim')
    const action = claimAction(params.get('action') || '')
    if (action) {
      const form = $('claim-form')
      form.action = action
      $('claim-code').value = params.get('code') || ''
      $('claim-verifier').value = params.get('code_verifier') || ''
      form.submit()
    }
  } else if (view === 'locations') {
    $('brand').hidden = true
    show('locations')
    initLocations()
  } else {
    show('status')
    $('status-text').textContent = STATUS[params.get('status')] || STATUS.starting
  }

  function initLocations() {
    const list = $('location-list')
    const row = $('location-row')
    const error = $('add-error')

    function fail(err) {
      error.textContent = String((err && err.message) || err)
      error.hidden = false
    }

    function render() {
      return invoke('locations_list').then(function (data) {
        list.replaceChildren()
        data.locations.forEach(function (loc) {
          const li = row.content.firstElementChild.cloneNode(true)
          li.querySelector('.row-name').textContent = loc.name
          li.querySelector('.row-url').textContent = loc.url
          if (loc.id === data.current) li.classList.add('row-current')
          li.querySelector('[data-action=open]').addEventListener('click', function () {
            quiet('location_switch', { id: loc.id })
          })
          const rename = li.querySelector('[data-action=rename]')
          rename.addEventListener('click', function () {
            const label = li.querySelector('.row-name')
            if (rename.textContent === 'Save') {
              const input = label.querySelector('input')
              invoke('location_rename', { id: loc.id, name: input.value }).then(render, fail)
              return
            }
            const input = document.createElement('input')
            input.type = 'text'
            input.value = loc.name
            label.replaceChildren(input)
            input.focus()
            input.select()
            input.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') rename.click()
              if (e.key === 'Escape') render()
            })
            rename.textContent = 'Save'
          })
          li.querySelector('[data-action=remove]').addEventListener('click', function () {
            const sure = window.confirm('Remove ' + loc.name + '? This Mac signs out of it and forgets its data.')
            if (!sure) return
            invoke('location_remove', { id: loc.id }).then(render, fail)
          })
          list.appendChild(li)
        })
      }, fail)
    }

    $('add-form').addEventListener('submit', function (event) {
      event.preventDefault()
      error.hidden = true
      const submit = $('add-submit')
      submit.disabled = true
      submit.textContent = 'Checking…'
      const name = $('add-name').value.trim()
      invoke('location_add', { url: $('add-url').value, name: name || null })
        .then(function () {
          $('add-url').value = ''
          $('add-name').value = ''
          return render()
        }, fail)
        .then(function () {
          submit.disabled = false
          submit.textContent = 'Add and Open'
        })
    })

    if (params.get('mode') === 'add') $('add-url').focus()
    render()
  }
})()
