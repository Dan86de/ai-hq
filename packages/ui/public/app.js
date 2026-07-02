// @ts-check
// HQ web UI, hash-routed over the Daemon's HTTP API.
// '#/' renders the Session list; '#/sessions/<id>' renders the Session detail
// screen, whose Transcript and pending Decision banner stream from the
// Daemon's SSE endpoint.

/**
 * Mirrors the Session contract in @ai-hq/core (contracts.ts).
 * @typedef {object} Session
 * @property {string} id
 * @property {string} repoPath
 * @property {string} prompt
 * @property {'running' | 'waiting_on_human' | 'completed' | 'failed'} status
 * @property {string | null} sdkSessionId
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Mirrors the Event contract in @ai-hq/core (events.ts).
 * @typedef {object} HqEvent
 * @property {number} seq
 * @property {string} sessionId
 * @property {string} type
 * @property {any} payload
 * @property {string} ts
 */

const POLL_INTERVAL_MS = 1500

const STATUS_LABELS = {
  running: 'running',
  waiting_on_human: 'waiting on human',
  completed: 'completed',
  failed: 'failed',
}

const appRoot = /** @type {HTMLElement} */ (document.getElementById('app'))
const connectionBanner = /** @type {HTMLElement} */ (document.getElementById('connection'))

/** Cleanup callbacks for the active screen, run before the next screen renders. */
/** @type {(() => void)[]} */
const teardown = []

/** @param {string} isoDate */
function formatAge(isoDate) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(isoDate)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** @param {string} isoDate */
function formatTime(isoDate) {
  return new Date(isoDate).toLocaleTimeString([], { hour12: false })
}

/** @param {Session['status']} status */
function statusBadge(status) {
  const badge = document.createElement('span')
  badge.className = `badge badge--${status}`
  badge.textContent = STATUS_LABELS[status] ?? status
  return badge
}

// ---- Session list screen ----

/** @param {Session} session */
function renderRow(session) {
  const row = document.createElement('tr')
  row.className = 'session-row'

  const status = document.createElement('td')
  status.append(statusBadge(session.status))

  const repo = document.createElement('td')
  repo.className = 'repo-path'
  repo.textContent = session.repoPath
  repo.title = session.repoPath

  const prompt = document.createElement('td')
  const link = document.createElement('a')
  link.className = 'session-link'
  link.href = `#/sessions/${encodeURIComponent(session.id)}`
  link.textContent = session.prompt
  link.title = session.prompt
  prompt.append(link)

  const updated = document.createElement('td')
  updated.className = 'updated'
  updated.textContent = formatAge(session.updatedAt)

  row.append(status, repo, prompt, updated)
  row.addEventListener('click', () => {
    location.hash = `#/sessions/${encodeURIComponent(session.id)}`
  })
  return row
}

/**
 * @param {HTMLElement} container
 * @param {Session[]} sessions
 */
function renderSessions(container, sessions) {
  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    const code = document.createElement('code')
    code.textContent = 'hq run --repo <path> --prompt "<task>"'
    empty.append('no sessions yet - launch one with ', code)
    container.replaceChildren(empty)
    return
  }

  const table = document.createElement('table')
  const colgroup = document.createElement('colgroup')
  for (const name of ['status', 'repo', 'prompt', 'updated']) {
    const col = document.createElement('col')
    col.className = name
    colgroup.append(col)
  }

  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of ['Status', 'Repo', 'Prompt', 'Updated']) {
    const th = document.createElement('th')
    th.textContent = label
    headRow.append(th)
  }
  head.append(headRow)

  const body = document.createElement('tbody')
  for (const session of sessions) {
    body.append(renderRow(session))
  }

  table.append(colgroup, head, body)
  container.replaceChildren(table)
}

function renderListScreen() {
  const heading = document.createElement('h2')
  heading.textContent = 'Sessions'
  const container = document.createElement('div')
  appRoot.replaceChildren(heading, container)

  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  teardown.push(() => {
    stopped = true
    clearTimeout(timer)
  })

  async function poll() {
    try {
      const response = await fetch('/sessions')
      if (!response.ok) throw new Error(`daemon returned ${response.status}`)
      const { sessions } = /** @type {{ sessions: Session[] }} */ (await response.json())
      if (stopped) return
      connectionBanner.hidden = true
      renderSessions(container, sessions)
    } catch {
      if (!stopped) connectionBanner.hidden = false
    } finally {
      if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }
  }

  void poll()
}

// ---- Transcript rendering ----

/** @param {string} text */
function marker(text) {
  const span = document.createElement('span')
  span.className = 'marker'
  span.textContent = text
  return span
}

/** @param {string} text */
function kindLabel(text) {
  const span = document.createElement('span')
  span.className = 'entry-kind'
  span.textContent = text
  return span
}

/** @param {string} text */
function codeBlock(text) {
  const pre = document.createElement('pre')
  pre.className = 'entry-input'
  pre.textContent = text
  return pre
}

/**
 * Renders one Event as a Transcript entry.
 * @param {HqEvent} event
 */
function renderEntry(event) {
  const entry = document.createElement('li')
  entry.className = `entry entry--${event.type}`

  const time = document.createElement('time')
  time.className = 'entry-time'
  time.dateTime = event.ts
  time.textContent = formatTime(event.ts)

  const body = document.createElement('div')
  body.className = 'entry-body'
  entry.append(time, body)

  switch (event.type) {
    case 'session_launched':
      body.append(marker('session launched'))
      break
    case 'agent_initialized':
      body.append(marker('agent initialized'))
      break
    case 'agent_message': {
      const text = document.createElement('p')
      text.className = 'entry-text'
      text.textContent = String(event.payload?.text ?? '')
      body.append(kindLabel('agent'), text)
      break
    }
    case 'tool_call': {
      const name = document.createElement('code')
      name.className = 'tool-name'
      name.textContent = String(event.payload?.toolName ?? 'unknown tool')
      body.append(kindLabel('tool'), name)
      if (event.payload?.input !== undefined) {
        body.append(codeBlock(JSON.stringify(event.payload.input, null, 2)))
      }
      break
    }
    case 'decision_requested': {
      const name = document.createElement('code')
      name.className = 'tool-name'
      name.textContent = String(event.payload?.toolName ?? 'unknown tool')
      body.append(kindLabel('gated'), name)
      if (event.payload?.input !== undefined) {
        body.append(codeBlock(JSON.stringify(event.payload.input, null, 2)))
      }
      break
    }
    case 'decision_decided': {
      const status = String(event.payload?.status ?? 'decided')
      const note = event.payload?.note
      body.append(marker(note == null || note === '' ? status : `${status} - ${String(note)}`))
      break
    }
    case 'session_completed':
      body.append(marker('session completed'))
      break
    case 'session_failed':
      body.append(marker(`session failed - ${String(event.payload?.error ?? 'unknown error')}`))
      break
    default:
      // Future Event types still show up rather than silently disappearing.
      body.append(kindLabel(event.type), codeBlock(JSON.stringify(event.payload, null, 2)))
  }

  return entry
}

/**
 * @param {HTMLElement} transcript
 * @param {HqEvent} event
 */
function appendEntry(transcript, event) {
  // Follow the live Transcript only while the Operator is already at the bottom.
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 60
  transcript.append(renderEntry(event))
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight })
}

// ---- Decision banner ----

/**
 * One pending Decision card: the exact tool name, the full tool input, and the
 * Operator's two rulings. The card never removes itself - the decision_decided
 * Event on the stream clears it, so it also clears when the Verdict came from
 * somewhere else (curl, another tab).
 * @param {string} decisionId
 * @param {string} toolName
 * @param {unknown} input
 */
function renderDecisionCard(decisionId, toolName, input) {
  const card = document.createElement('article')
  card.className = 'decision-card'

  const title = document.createElement('span')
  title.className = 'decision-title'
  title.textContent = 'pending decision'

  const name = document.createElement('code')
  name.className = 'tool-name'
  name.textContent = toolName

  const header = document.createElement('div')
  header.className = 'decision-card-header'
  header.append(title, name)

  const approve = document.createElement('button')
  approve.type = 'button'
  approve.className = 'verdict-button decision-approve'
  approve.textContent = 'Approve'

  const note = document.createElement('input')
  note.className = 'decision-note'
  note.placeholder = 'note to the agent (optional)'

  const deny = document.createElement('button')
  deny.type = 'button'
  deny.className = 'verdict-button decision-deny'
  deny.textContent = 'Deny'

  const actions = document.createElement('div')
  actions.className = 'decision-actions'
  actions.append(approve, note, deny)

  /** @param {{ behavior: 'approve' } | { behavior: 'deny', note?: string }} verdict */
  async function sendVerdict(verdict) {
    approve.disabled = true
    deny.disabled = true
    try {
      const response = await fetch(`/decisions/${encodeURIComponent(decisionId)}/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(verdict),
      })
      // 409 means someone already ruled; that ruling's Event clears the card.
      if (!response.ok && response.status !== 409) {
        throw new Error(`daemon returned ${response.status}`)
      }
    } catch {
      approve.disabled = false
      deny.disabled = false
    }
  }

  approve.addEventListener('click', () => void sendVerdict({ behavior: 'approve' }))
  deny.addEventListener('click', () => {
    const text = note.value.trim()
    void sendVerdict(text === '' ? { behavior: 'deny' } : { behavior: 'deny', note: text })
  })

  card.append(header, codeBlock(JSON.stringify(input ?? null, null, 2)), actions)
  return card
}

// ---- Session detail screen ----

/** @param {string} sessionId */
function renderDetailScreen(sessionId) {
  const back = document.createElement('a')
  back.className = 'back-link'
  back.href = '#/'
  back.textContent = '← sessions'

  const sessionHeader = document.createElement('div')
  sessionHeader.className = 'session-header'
  const badgeSlot = document.createElement('span')
  const repo = document.createElement('code')
  repo.className = 'repo-path'
  sessionHeader.append(badgeSlot, repo)

  const prompt = document.createElement('p')
  prompt.className = 'session-prompt'

  const decisions = document.createElement('section')
  decisions.className = 'decisions'
  decisions.hidden = true

  const transcriptHeading = document.createElement('h2')
  transcriptHeading.textContent = 'Transcript'

  const transcript = document.createElement('ol')
  transcript.className = 'transcript'

  appRoot.replaceChildren(back, sessionHeader, prompt, decisions, transcriptHeading, transcript)

  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer
  teardown.push(() => {
    stopped = true
    clearTimeout(retryTimer)
  })

  /** @param {Session['status']} status */
  function setStatus(status) {
    badgeSlot.replaceChildren(statusBadge(status))
  }

  /** Pending Decision cards in the banner, keyed by Decision id. */
  /** @type {Map<string, HTMLElement>} */
  const decisionCards = new Map()

  /** @param {HqEvent} event */
  function parkDecision(event) {
    const decisionId = String(event.payload?.decisionId ?? '')
    if (decisionId === '' || decisionCards.has(decisionId)) return
    const card = renderDecisionCard(
      decisionId,
      String(event.payload?.toolName ?? 'unknown tool'),
      event.payload?.input,
    )
    decisionCards.set(decisionId, card)
    decisions.append(card)
    decisions.hidden = false
    setStatus('waiting_on_human')
  }

  /** @param {HqEvent} event */
  function clearDecision(event) {
    const decisionId = String(event.payload?.decisionId ?? '')
    const card = decisionCards.get(decisionId)
    if (card === undefined) return
    decisionCards.delete(decisionId)
    card.remove()
    if (decisionCards.size === 0) {
      decisions.hidden = true
      // A terminal Event later in the stream overrides this for finished Sessions.
      setStatus('running')
    }
  }

  function openStream() {
    const source = new EventSource(`/sessions/${encodeURIComponent(sessionId)}/events`)
    teardown.push(() => source.close())
    source.onopen = () => {
      connectionBanner.hidden = true
    }
    // EventSource reconnects on its own and resumes exactly via Last-Event-ID.
    source.onerror = () => {
      connectionBanner.hidden = false
    }
    source.onmessage = (message) => {
      connectionBanner.hidden = true
      const event = /** @type {HqEvent} */ (JSON.parse(message.data))
      appendEntry(transcript, event)
      if (event.type === 'decision_requested') parkDecision(event)
      if (event.type === 'decision_decided') clearDecision(event)
      if (event.type === 'session_completed') setStatus('completed')
      if (event.type === 'session_failed') setStatus('failed')
    }
  }

  async function loadSession() {
    /** @type {Response} */
    let response
    try {
      response = await fetch(`/sessions/${encodeURIComponent(sessionId)}`)
    } catch {
      if (stopped) return
      connectionBanner.hidden = false
      retryTimer = setTimeout(loadSession, POLL_INTERVAL_MS)
      return
    }
    if (stopped) return
    if (response.status === 404) {
      const missing = document.createElement('p')
      missing.className = 'empty'
      missing.textContent = 'session not found'
      appRoot.replaceChildren(back, missing)
      return
    }
    if (!response.ok) {
      connectionBanner.hidden = false
      retryTimer = setTimeout(loadSession, POLL_INTERVAL_MS)
      return
    }
    connectionBanner.hidden = true
    const { session } = /** @type {{ session: Session }} */ (await response.json())
    if (stopped) return
    setStatus(session.status)
    repo.textContent = session.repoPath
    repo.title = session.repoPath
    prompt.textContent = session.prompt
    openStream()
  }

  void loadSession()
}

// ---- Router ----

function route() {
  for (const cleanup of teardown.splice(0)) cleanup()
  const match = /^#\/sessions\/([^/]+)$/.exec(location.hash)
  const sessionId = match?.[1]
  if (sessionId !== undefined) {
    renderDetailScreen(decodeURIComponent(sessionId))
  } else {
    renderListScreen()
  }
}

window.addEventListener('hashchange', route)
route()
