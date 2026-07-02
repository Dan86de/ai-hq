import { resolve } from 'node:path'
import { Command } from 'commander'
import {
  launchSessionResponseSchema,
  listSessionsResponseSchema,
  type Session,
} from '@ai-hq/core'

const baseUrl = process.env['HQ_URL'] ?? 'http://127.0.0.1:4747'

const PROMPT_SUMMARY_LENGTH = 40

function summarizePrompt(prompt: string): string {
  const flat = prompt.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= PROMPT_SUMMARY_LENGTH ? flat : `${flat.slice(0, PROMPT_SUMMARY_LENGTH - 3)}...`
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, init)
  } catch {
    console.error(`hq daemon is not reachable at ${baseUrl} - start it with hq-daemon`)
    process.exit(1)
  }
  if (!response.ok) {
    console.error(`hq daemon returned ${response.status}: ${await response.text()}`)
    process.exit(1)
  }
  return response.json()
}

function printSessions(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.log('no sessions yet - launch one with: hq run --repo <path> --prompt "<task>"')
    return
  }
  const rows = sessions.map((session) => [
    session.id.slice(0, 8),
    session.status,
    session.repoPath,
    summarizePrompt(session.prompt),
  ])
  const header = ['ID', 'STATUS', 'REPO', 'PROMPT']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)))
  for (const row of [header, ...rows]) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
  }
}

const program = new Command()
program.name('hq').description('Local-first control plane for AI coding agent sessions')

program
  .command('run')
  .description('launch a Session against a repo')
  .requiredOption('--repo <path>', 'path to the repository to work in')
  .requiredOption('--prompt <task>', 'task prompt for the agent')
  .action(async (options: { repo: string; prompt: string }) => {
    const body = JSON.stringify({ repoPath: resolve(options.repo), prompt: options.prompt })
    const json = await request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const { session } = launchSessionResponseSchema.parse(json)
    console.log(session.id)
  })

program
  .command('ls')
  .description('list Sessions')
  .action(async () => {
    const json = await request('/sessions')
    const { sessions } = listSessionsResponseSchema.parse(json)
    printSessions(sessions)
  })

await program.parseAsync(process.argv)
