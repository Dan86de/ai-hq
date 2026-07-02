import { fileURLToPath } from 'node:url'

/** Absolute path to the static Session list UI that the Daemon serves. */
export const uiDir = fileURLToPath(new URL('../public', import.meta.url))
