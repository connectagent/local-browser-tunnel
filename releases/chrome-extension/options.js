const DEFAULT_RELAY_URL = 'http://127.0.0.1:5095'
const CONNECT_URL = 'http://operator.max0.dev/connect'
const POLL_URL = 'http://operator.max0.dev/api/connect/poll'

// ---------------------------------------------------------------------------
// State singleton
// ---------------------------------------------------------------------------
const State = (() => {
  let current = null

  function set(newState, reason) {
    if (current === newState) return
    current = newState
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const entry = `[${ts}] State → ${newState}${reason ? ': ' + reason : ''}`
    chrome.storage.local.get(['connectionLog'], (stored) => {
      const log = Array.isArray(stored.connectionLog) ? stored.connectionLog : []
      log.push(entry)
      if (log.length > 200) log.splice(0, log.length - 200)
      chrome.storage.local.set({ connectionLog: log })
    })
    render()
  }

  function render() {
    const nameEl = document.getElementById('state-name')
    const dotEl = document.getElementById('state-dot')
    const loginRow = document.getElementById('state-login-row')
    if (nameEl) nameEl.textContent = current || '—'
    const ready         = current === 'Ready'
    const readyNoAttach = current === 'Ready but not Attached'
    const offline       = current === 'Offline'
    const unconfigured  = current === 'Unconfigured'
    const isReady = ready || readyNoAttach
    if (dotEl) {
      dotEl.hidden = !ready && !readyNoAttach && !offline && !unconfigured
      dotEl.style.background = ready ? '#16a34a' : readyNoAttach ? '#eab308' : offline ? '#dc2626' : '#f97316'
    }
    if (loginRow) loginRow.style.display = isReady ? 'none' : 'flex'
    const reconnectBtn = document.getElementById('state-reconnect-btn')
    if (reconnectBtn) reconnectBtn.style.display = offline ? 'inline-block' : 'none'
    const attachRow = document.getElementById('state-attach-row')
    if (attachRow) attachRow.style.display = isReady ? 'flex' : 'none'
    const tabCountEl = document.getElementById('state-tab-count')
    const tabListEl  = document.getElementById('state-tab-list')
    if (isReady) {
      chrome.storage.local.get(['attachedTabCount', 'attachedTabs'], (stored) => {
        const n = stored.attachedTabCount || 0
        if (tabCountEl) {
          tabCountEl.textContent = `${n} tab${n === 1 ? '' : 's'} attached`
          tabCountEl.style.display = 'block'
        }
        renderTabList(stored.attachedTabs || [])
      })
    } else {
      if (tabCountEl) tabCountEl.style.display = 'none'
      if (tabListEl)  tabListEl.style.display  = 'none'
    }
  }

  return { set, render, get: () => current }
})()

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
async function setReady(reason) {
  const stored = await chrome.storage.local.get(['attachedTabCount'])
  const n = stored.attachedTabCount || 0
  State.set(n > 0 ? 'Ready' : 'Ready but not Attached', reason)
}

function normalizeUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '')
  if (!raw) return DEFAULT_RELAY_URL
  try {
    new URL(raw)
    return raw
  } catch {
    return DEFAULT_RELAY_URL
  }
}

function renderTabList(tabInfos) {
  const el = document.getElementById('state-tab-list')
  if (!el) return
  el.innerHTML = ''
  if (!tabInfos || tabInfos.length === 0) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'flex'
  tabInfos.forEach((tab) => {
    const row = document.createElement('div')
    row.className = 'tab-row'

    const name = document.createElement('span')
    name.className = 'tab-name'
    name.textContent = tab.title
    name.title = tab.title

    const btn = document.createElement('button')
    btn.className = 'btn-detach'
    btn.textContent = 'Detach'
    btn.addEventListener('click', () => {
      btn.disabled = true
      chrome.runtime.sendMessage({ type: 'detachTab', tabId: tab.id }).catch(() => {
        btn.disabled = false
      })
    })

    row.appendChild(name)
    row.appendChild(btn)
    el.appendChild(row)
  })
}

function setStatus(kind, message) {
  const el = document.getElementById('status')
  if (!el) return
  el.dataset.kind = kind || ''
  el.textContent = message || ''
}

function setTokenStatus(kind, message) {
  const el = document.getElementById('status-token')
  if (!el) return
  el.dataset.kind = kind || ''
  el.textContent = message || ''
}

function setLoginStatus(kind, message) {
  const el = document.getElementById('status-login')
  if (!el) return
  el.dataset.kind = kind || ''
  el.textContent = message || ''
}

function renderLog(entries) {
  const el = document.getElementById('conn-log')
  if (!el) return
  if (!entries || entries.length === 0) {
    el.textContent = '(no log entries yet)'
    return
  }
  el.textContent = entries.join('\n')
  el.scrollTop = el.scrollHeight
}

async function checkRelayReachable(httpUrl) {
  const url = httpUrl + '/'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 900)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable at ${url}`)
  } catch {
    setStatus('error', `Relay not reachable at ${url}. Make sure the relay server is running.`)
    const stored = await chrome.storage.local.get(['tunnelToken'])
    if (stored.tunnelToken) {
      State.set('Offline', 'Relay not reachable')
    } else {
      State.set('Unconfigured', 'No token configured')
    }
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
async function load() {
  const stored = await chrome.storage.local.get(['relayUrl', 'tunnelToken', 'authError', 'connectAutomatically', 'connectionLog'])
  const url = normalizeUrl(stored.relayUrl)
  document.getElementById('relay-url').value = url
  document.getElementById('tunnel-token').value = String(stored.tunnelToken || '')
  document.getElementById('connect-automatically').checked = stored.connectAutomatically !== false
  renderLog(stored.connectionLog)
  if (stored.authError) setTokenStatus('error', stored.authError)

  if (stored.tunnelToken) {
    State.set('Offline', 'Token loaded, not yet tested')
    await testToken()
  } else {
    State.set('Unconfigured', 'No token configured')
  }

  await checkRelayReachable(url)
}

chrome.storage.onChanged.addListener((changes) => {
  if ('authError' in changes) {
    const val = String(changes.authError.newValue || '')
    setTokenStatus(val ? 'error' : '', val)
  }
  if ('connectionLog' in changes) {
    renderLog(changes.connectionLog.newValue)
  }
  if ('relayState' in changes) {
    if (changes.relayState.newValue === 'offline') {
      chrome.storage.local.get(['tunnelToken'], (stored) => {
        if (stored.tunnelToken) State.set('Offline', 'Relay disconnected')
      })
    } else if (changes.relayState.newValue === 'connected') {
      void setReady('Relay reconnected')
    } else if (changes.relayState.newValue === 'ready_no_attach') {
      State.set('Ready but not Attached', 'All tabs detached')
    }
  }
  if ('attachedTabCount' in changes || 'attachedTabs' in changes) {
    const n = ('attachedTabCount' in changes ? changes.attachedTabCount.newValue : null)
           ?? changes.attachedTabs?.newValue?.length ?? 0
    const cur = State.get()
    if (cur === 'Ready' || cur === 'Ready but not Attached') {
      State.set(n > 0 ? 'Ready' : 'Ready but not Attached', n > 0 ? `${n} tab${n === 1 ? '' : 's'} attached` : 'All tabs detached')
    }
    const countEl = document.getElementById('state-tab-count')
    if (countEl && countEl.style.display !== 'none') {
      countEl.textContent = `${n} tab${n === 1 ? '' : 's'} attached`
      renderTabList(('attachedTabs' in changes ? changes.attachedTabs.newValue : null) ?? [])
    }
  }
})

// ---------------------------------------------------------------------------
// Relay URL
// ---------------------------------------------------------------------------
async function save() {
  const input = document.getElementById('relay-url')
  const url = normalizeUrl(input.value)
  await chrome.storage.local.set({ relayUrl: url })
  input.value = url
  await checkRelayReachable(url)
}

async function test() {
  const url = normalizeUrl(document.getElementById('relay-url').value)
  await checkRelayReachable(url)
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
async function saveToken() {
  const token = String(document.getElementById('tunnel-token').value || '').trim()
  await chrome.storage.local.set({ tunnelToken: token })
  if (token) {
    setTokenStatus('ok', 'Token saved.')
    State.set('Offline', 'Token saved, not yet tested')
  } else {
    setTokenStatus('ok', 'Token cleared.')
    State.set('Unconfigured', 'Token cleared')
  }
}

async function testToken() {
  const relayUrl = normalizeUrl(document.getElementById('relay-url').value)
  const token = String(document.getElementById('tunnel-token').value || '').trim()

  if (!token) {
    setTokenStatus('error', 'No token to test.')
    State.set('Unconfigured', 'No token configured')
    return
  }

  const wsUrlBase = relayUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/on_connect_destination'
  const wsUrl = wsUrlBase + '?token=' + encodeURIComponent(token)

  setTokenStatus('', `Testing ${wsUrlBase}…`)

  // Preflight: verify the relay HTTP endpoint is reachable before opening WebSocket.
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(relayUrl + '/', { method: 'HEAD', signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } finally {
      clearTimeout(t)
    }
  } catch {
    setTokenStatus('error', `Relay not reachable at ${relayUrl}`)
    State.set('Offline', 'Relay not reachable')
    return
  }

  await new Promise((resolve) => {
    let settled = false
    const done = (kind, msg, state, reason) => {
      if (settled) return
      settled = true
      setTokenStatus(kind, `${msg} (${wsUrlBase})`)
      if (state === 'Ready') void setReady(reason)
      else State.set(state, reason)
      resolve()
    }

    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      done('error', 'Invalid WebSocket URL.', 'Offline', 'Invalid WebSocket URL')
      return
    }

    const timeout = setTimeout(() => {
      ws.close()
      done('ok', 'Token accepted.', 'Ready', 'Token accepted by relay')
    }, 1000)

    ws.onmessage = (event) => {
      clearTimeout(timeout)
      ws.close()
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.method === 'error' && msg.code === 401) {
          done('error', 'Not authorized.', 'Unconfigured', 'Token rejected (401)')
          return
        }
      } catch { /* ignore */ }
      done('ok', 'Token accepted.', 'Ready', 'Token accepted by relay')
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      done('error', 'Cannot connect to relay.', 'Offline', 'Cannot connect to relay')
    }

    ws.onclose = () => {
      clearTimeout(timeout)
      if (!settled) done('error', 'Connection closed unexpectedly.', 'Offline', 'Connection closed unexpectedly')
    }
  })
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
async function login() {
  const btns = [document.getElementById('login'), document.getElementById('state-login-btn')]
  btns.forEach((b) => { if (b) b.disabled = true })
  try {
    const deviceCode = crypto.randomUUID()
    window.open(`${CONNECT_URL}?code=${deviceCode}`, '_blank')
    setLoginStatus('', 'Waiting for approval in browser…')

    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const resp = await fetch(`${POLL_URL}?code=${encodeURIComponent(deviceCode)}`, {
          signal: AbortSignal.timeout(10000),
        })
        if (resp.status === 200) {
          const data = await resp.json()
          await chrome.storage.local.set({ tunnelToken: data.token, userId: data.user_id ?? null })
          document.getElementById('tunnel-token').value = data.token
          setLoginStatus('ok', 'Login successful. Token saved.')
          void setReady('Logged in successfully')
          return
        }
        if (resp.status === 410) {
          setLoginStatus('error', 'Authorization expired. Please try again.')
          return
        }
      } catch {
        // poll failure — keep retrying
      }
    }
    setLoginStatus('error', 'Authorization timeout. Please try again.')
  } finally {
    btns.forEach((b) => { if (b) b.disabled = false })
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
document.getElementById('state-attach-btn').addEventListener('click', async () => {
  const btn = document.getElementById('state-attach-btn')
  btn.disabled = true
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'createAndAttachTab' })
    if (!resp?.ok) {
      State.set('Offline', resp?.error || 'Failed to connect to relay')
    }
  } catch (e) {
    State.set('Offline', String(e))
  } finally {
    btn.disabled = false
  }
})

document.getElementById('connect-automatically').addEventListener('change', (e) => {
  void chrome.storage.local.set({ connectAutomatically: e.target.checked })
})
document.getElementById('clear-log').addEventListener('click', () => {
  void chrome.storage.local.set({ connectionLog: [] })
})
document.getElementById('login').addEventListener('click', () => void login())
document.getElementById('state-reconnect-btn').addEventListener('click', () => void testToken())
document.getElementById('state-login-btn').addEventListener('click', () => void login())
document.getElementById('save').addEventListener('click', () => void save())
document.getElementById('test').addEventListener('click', () => void test())
document.getElementById('save-token').addEventListener('click', () => void saveToken())
document.getElementById('test-token').addEventListener('click', () => void testToken())
document.getElementById('clear-token').addEventListener('click', async () => {
  document.getElementById('tunnel-token').value = ''
  await chrome.storage.local.set({ tunnelToken: '' })
  setTokenStatus('ok', 'Token cleared.')
  State.set('Unconfigured', 'Token cleared')
})
function initTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  function apply(pref) {
    const dark = pref === 'dark' || (pref === 'system' && mq.matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.querySelectorAll('.seg-btn[data-theme-opt]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeOpt === pref)
    })
  }

  const saved = localStorage.getItem('theme-pref') || 'system'
  apply(saved)

  document.querySelectorAll('.seg-btn[data-theme-opt]').forEach((b) => {
    b.addEventListener('click', () => {
      localStorage.setItem('theme-pref', b.dataset.themeOpt)
      apply(b.dataset.themeOpt)
    })
  })

  mq.addEventListener('change', () => {
    apply(localStorage.getItem('theme-pref') || 'system')
  })
}

function initCollapsible() {
  document.querySelectorAll('details.card[id]').forEach((el) => {
    const key = 'card-open:' + el.id
    const saved = localStorage.getItem(key)
    if (saved !== null) el.open = saved === 'true'
    el.addEventListener('toggle', () => localStorage.setItem(key, String(el.open)))
  })
}

initTheme()
initCollapsible()
void load()
