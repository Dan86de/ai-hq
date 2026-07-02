// @ts-check
// Session list screen: polls the Daemon's /sessions API and re-renders.

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

const POLL_INTERVAL_MS = 1500

const STATUS_LABELS = {
  running: 'running',
  waiting_on_human: 'waiting on human',
  completed: 'completed',
  failed: 'failed',
}

const sessionsContainer = /** @type {HTMLElement} */ (document.getElementById('sessions'))
const connectionBanner = /** @type {HTMLElement} */ (document.getElementById('connection'))

/** @param {string} isoDate */
function formatAge(isoDate) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(isoDate)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** @param {Session} session */
function renderRow(session) {
  const row = document.createElement('tr')

  const status = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `badge badge--${session.status}`
  badge.textContent = STATUS_LABELS[session.status] ?? session.status
  status.append(badge)

  const repo = document.createElement('td')
  repo.className = 'repo-path'
  repo.textContent = session.repoPath
  repo.title = session.repoPath

  const prompt = document.createElement('td')
  prompt.textContent = session.prompt
  prompt.title = session.prompt

  const updated = document.createElement('td')
  updated.className = 'updated'
  updated.textContent = formatAge(session.updatedAt)

  row.append(status, repo, prompt, updated)
  return row
}

/** @param {Session[]} sessions */
function render(sessions) {
  if (sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    const code = document.createElement('code')
    code.textContent = 'hq run --repo <path> --prompt "<task>"'
    empty.append('no sessions yet - launch one with ', code)
    sessionsContainer.replaceChildren(empty)
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
  sessionsContainer.replaceChildren(table)
}

async function poll() {
  try {
    const response = await fetch('/sessions')
    if (!response.ok) throw new Error(`daemon returned ${response.status}`)
    const { sessions } = /** @type {{ sessions: Session[] }} */ (await response.json())
    connectionBanner.hidden = true
    render(sessions)
  } catch {
    connectionBanner.hidden = false
  } finally {
    setTimeout(poll, POLL_INTERVAL_MS)
  }
}

void poll()
