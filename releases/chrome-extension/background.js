const DEFAULT_RELAY_URL = 'http://127.0.0.1:5095'

const BADGE = {
  on: { text: 'ON', color: '#16A34A' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayUrl() {
  const stored = await chrome.storage.local.get(['relayUrl'])
  const raw = String(stored.relayUrl || '').trim().replace(/\/$/, '')
  if (!raw) return DEFAULT_RELAY_URL
  try {
    new URL(raw)
    return raw
  } catch {
    return DEFAULT_RELAY_URL
  }
}

async function getTunnelToken() {
  const stored = await chrome.storage.local.get(['tunnelToken'])
  return String(stored.tunnelToken || '').trim()
}

async function getUserId() {
  const stored = await chrome.storage.local.get(['userId'])
  return stored.userId ? String(stored.userId).trim() : null
}

async function getConnectAutomatically() {
  const stored = await chrome.storage.local.get(['connectAutomatically'])
  return stored.connectAutomatically !== false
}

const LOG_MAX = 200

function appendLog(message) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const entry = `[${ts}] ${message}`
  chrome.storage.local.get(['connectionLog'], (stored) => {
    const log = Array.isArray(stored.connectionLog) ? stored.connectionLog : []
    log.push(entry)
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX)
    chrome.storage.local.set({ connectionLog: log })
  })
}

function syncTabCount() {
  const connected = [...tabs.entries()].filter(([, t]) => t.state === 'connected')
  Promise.all(
    connected.map(async ([tabId]) => {
      try {
        const tab = await chrome.tabs.get(tabId)
        return { id: tabId, title: tab.title || tab.url || `Tab ${tabId}` }
      } catch {
        return { id: tabId, title: `Tab ${tabId}` }
      }
    })
  ).then((attachedTabs) => {
    chrome.storage.local.set({ attachedTabCount: attachedTabs.length, attachedTabs })
  })
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const httpBase = await getRelayUrl()
    const token = await getTunnelToken()
    const userId = await getUserId()
    const params = new URLSearchParams()
    if (token) params.set('token', token)
    if (userId) params.set('user_id', userId)
    params.set('hostname', 'Chrome Extension')
    const query = params.toString()
    const wsPath = '/on_connect_destination' + (query ? '?' + query : '')
    const wsUrl = httpBase.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + wsPath

    appendLog(`Connecting to relay ${httpBase}…`)

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      const msg = `Relay not reachable at ${httpBase}: ${String(err)}`
      appendLog(`ERROR: ${msg}`)
      throw new Error(msg)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    appendLog(`Connected to ${httpBase}`)
    void chrome.storage.local.remove('authError')
    void chrome.storage.local.set({ relayState: 'connected' })
    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } catch (err) {
    appendLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  } finally {
    relayConnectPromise = null
  }
}

let reconnectTimer = null
const RECONNECT_ALARM = 'relay-reconnect'
let relayClosedIntentionally = false

function onRelayClosed(reason) {
  const intentional = relayClosedIntentionally
  relayClosedIntentionally = false
  appendLog(intentional ? 'Relay closed (all tabs detached)' : `Relay disconnected (${reason})`)
  void chrome.storage.local.set({ relayState: intentional ? 'ready_no_attach' : 'offline' })
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  const prevTabIds = [...tabs.keys()]
  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'Local Browser Relay: disconnected (reconnecting…)',
    })
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  syncTabCount()

  scheduleReconnect(prevTabIds)
}

function scheduleReconnect(tabIds) {
  if (tabIds.length === 0) return

  // Persist tab IDs so the alarm can restart the loop if the service worker is killed.
  chrome.storage.local.set({ reconnectTabIds: tabIds })
  // Alarm fires every minute as a fallback when setTimeout is lost after SW restart.
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1 })

  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(doReconnect, 1000)
}

async function doReconnect() {
  reconnectTimer = null
  const stored = await chrome.storage.local.get(['reconnectTabIds', 'connectAutomatically'])
  const tabIds = stored.reconnectTabIds
  if (!tabIds?.length) return
  if (stored.connectAutomatically === false) {
    chrome.storage.local.remove('reconnectTabIds')
    chrome.alarms.clear(RECONNECT_ALARM)
    return
  }

  appendLog('Auto-reconnect: attempting…')
  try {
    await ensureRelayConnection()
    for (const tabId of tabIds) {
      await attachTab(tabId).catch(() => {})
    }
    chrome.storage.local.remove('reconnectTabIds')
    chrome.alarms.clear(RECONNECT_ALARM)
  } catch {
    // Stay in the reconnect loop — next attempt in 1 second.
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(doReconnect, 1000)
  }
}

// Fallback: alarm wakes the service worker after it was killed during reconnect.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(doReconnect, 0)
})

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && msg.method === 'error') {
    if (msg.code === 401) {
      void chrome.storage.local.set({ authError: 'Not authorized.' })
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'Local Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  syncTabCount()
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  syncTabCount()
  void chrome.action.setTitle({
    tabId,
    title: 'Local Browser Relay (click to attach/detach)',
  })

  // Close the relay WebSocket when the last tab is detached.
  if (tabs.size === 0 && relayWs) {
    relayClosedIntentionally = true
    relayWs.close()
    relayWs = null
  }
}

function isRestrictedUrl(url) {
  if (!url) return true
  return /^(chrome|chrome-extension|chrome-devtools|about|data|javascript):/i.test(url)
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  if (isRestrictedUrl(active.url)) {
    void chrome.runtime.openOptionsPage()
    return
  }

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'Local Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'Local Browser Relay: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    void scheduleReconnect([tabId])
    // Extra breadcrumbs in chrome://extensions service worker logs.
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
}

chrome.storage.onChanged.addListener((changes) => {
  if (!('relayUrl' in changes)) return
  if (!relayWs) return  // no active connection, nothing to do
  appendLog(`Relay URL changed — reconnecting…`)
  relayWs.close()       // triggers onRelayClosed → scheduleReconnect with existing tabs
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'detachTab') {
    detachTab(msg.tabId, 'manual').then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg?.type === 'createAndAttachTab') {
    ;(async () => {
      let tab = null
      try {
        tab = await chrome.tabs.create({ url: 'about:blank', active: true })
        await new Promise((r) => setTimeout(r, 100))
        await ensureRelayConnection()
        await attachTab(tab.id)
        sendResponse({ ok: true })
      } catch (e) {
        if (tab?.id != null) scheduleReconnect([tab.id])
        sendResponse({ ok: false, error: String(e) })
      }
    })()
    return true
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabs.has(tabId) && (changeInfo.title !== undefined || changeInfo.status === 'complete')) {
    syncTabCount()
  }
})

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'local-browser', title: 'Local Browser', contexts: ['action'] })
    chrome.contextMenus.create({ id: 'attach-new', parentId: 'local-browser', title: 'Attach New', contexts: ['action'] })
    chrome.contextMenus.create({ id: 'options', parentId: 'local-browser', title: 'Options', contexts: ['action'] })
  })
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'options') {
    void chrome.runtime.openOptionsPage()
  } else if (info.menuItemId === 'attach-new') {
    ;(async () => {
      try {
        await ensureRelayConnection()
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
        await new Promise((r) => setTimeout(r, 100))
        await attachTab(tab.id)
      } catch (e) {
        console.warn('attach-new failed', String(e))
      }
    })()
  }
})

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus()
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage()
})

chrome.runtime.onStartup.addListener(async () => {
  createContextMenus()
  // Resume any in-progress reconnect from before Chrome was restarted.
  const stored = await chrome.storage.local.get(['reconnectTabIds'])
  if (stored.reconnectTabIds?.length) {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(doReconnect, 1000)
  }
})
