import { execFile } from 'node:child_process'
import type { Notification, NotificationDeliverer } from '@ai-hq/core'

// AppleScript string literals only need backslash and double-quote escaping.
function escapeAppleScriptString(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function osascriptNotificationArgs(notification: Notification): string[] {
  const body = escapeAppleScriptString(notification.body)
  const title = escapeAppleScriptString(notification.title)
  return ['-e', `display notification "${body}" with title "${title}"`]
}

/** Fires a native macOS notification. Best-effort: a failing osascript never disturbs the Daemon. */
export const deliverWithOsascript: NotificationDeliverer = (notification) => {
  execFile('osascript', osascriptNotificationArgs(notification), () => {})
}
