import { describe, expect, test } from 'vitest'
import { osascriptNotificationArgs } from '../src/osascript.ts'

// The args builder is tested pure; spawning osascript would pop real
// notifications on every test run.

describe('osascriptNotificationArgs', () => {
  test('builds a display notification command with title and body', () => {
    expect(
      osascriptNotificationArgs({ title: 'ai-hq - fix the login bug', body: 'Session completed' }),
    ).toEqual([
      '-e',
      'display notification "Session completed" with title "ai-hq - fix the login bug"',
    ])
  })

  test('escapes double quotes and backslashes in AppleScript strings', () => {
    const [, script] = osascriptNotificationArgs({
      title: 'repo - say "hi"',
      body: 'Decision parked: Bash \\ "quoted"',
    })

    expect(script).toBe(
      'display notification "Decision parked: Bash \\\\ \\"quoted\\"" with title "repo - say \\"hi\\""',
    )
  })
})
