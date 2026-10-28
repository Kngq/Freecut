#!/usr/bin/env node
// REPL driver for freecut, for agents (and humans) to drive the live Electron app without a
// real display session. Launches the Vite dev server (if not already up) plus a debug-enabled
// Electron instance, connects over the Chrome DevTools Protocol, and exposes commands over
// stdin. Screenshots go through CDP's own Page.captureScreenshot — NOT the OS `screencapture`
// tool — so this works with no Accessibility/Screen Recording permissions and no window-id
// lookups at all.
//
// Usage: node scripts/devDriver.mjs
//   then type commands at the `driver>` prompt (see COMMANDS below, or type `help`).
//
// Gotcha this driver exists because of: in dev mode the renderer loads from
// http://localhost:5173, not file://. <video>/<audio> elements loading a plain file:// src
// from that origin get rejected by Chromium's media URL safety check. The app works around
// this with a custom `freecut-media://` protocol registered in electron/main/index.ts — if
// you're debugging "nothing plays", that protocol registration is the first thing to check,
// not the player code.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(ROOT, '.dev-shots')
const DEBUG_PORT = Number(process.env.FREECUT_DEBUG_PORT || 9222)
const VITE_URL = process.env.FREECUT_VITE_URL || 'http://localhost:5173'
fs.mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

let electronProc = null
let ws = null
let nextId = 0
const pending = new Map()

async function viteIsUp() {
  try {
    const res = await fetch(VITE_URL, { method: 'HEAD' })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

async function cdpSend(method, params = {}) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
}

async function evaluate(expression) {
  const res = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) return { error: res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails) }
  return { value: res.result?.value }
}

const COMMANDS = {
  async launch() {
    if (electronProc) return console.log('already launched')
    if (!(await viteIsUp())) {
      console.log('vite not up, starting `npm run dev`…')
      const devProc = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'ignore', detached: true })
      devProc.unref()
      const ok = await waitFor(viteIsUp, 20_000)
      if (!ok) return console.log('ERROR: vite never came up')
    } else {
      console.log('vite already up, reusing it')
    }

    electronProc = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
      cwd: ROOT,
      env: { ...process.env, VITE_DEV_SERVER_URL: VITE_URL },
      stdio: 'ignore',
      detached: true
    })
    electronProc.unref()

    const got = await waitFor(async () => {
      try {
        const res = await fetch(`http://localhost:${DEBUG_PORT}/json/list`)
        const list = await res.json()
        return list.find((w) => w.type === 'page' && w.url.startsWith(VITE_URL))
      } catch {
        return false
      }
    }, 15_000)
    if (!got) return console.log('ERROR: electron debug port never came up')

    const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json()
    const target = list.find((w) => w.type === 'page' && w.url.startsWith(VITE_URL))
    // Node 22+ has a built-in global WebSocket — no `ws` package dependency needed.
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    await cdpSend('Page.enable')
    await new Promise((r) => setTimeout(r, 800)) // let React actually paint before the caller screenshots
    console.log('launched. title:', (await evaluate('document.title')).value)
  },

  async eval(expr) {
    if (!ws) return console.log('ERROR: launch first')
    console.log(JSON.stringify(await evaluate(expr)))
  },

  async evalFile(filePath) {
    if (!ws) return console.log('ERROR: launch first')
    const expr = fs.readFileSync(filePath, 'utf-8')
    console.log(JSON.stringify(await evaluate(expr)))
  },

  async screenshot(name) {
    if (!ws) return console.log('ERROR: launch first')
    const res = await cdpSend('Page.captureScreenshot', { format: 'png' })
    const file = path.join(SHOT_DIR, (name || `shot-${Date.now()}`) + '.png')
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
    console.log('screenshot:', file)
  },

  async wait(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 500))
  },

  async reload() {
    if (!ws) return console.log('ERROR: launch first')
    await cdpSend('Page.reload')
    console.log('reloaded')
  },

  async quit() {
    if (electronProc) {
      try {
        process.kill(-electronProc.pid)
      } catch {
        /* already gone */
      }
    }
    electronProc = null
    if (ws) ws.close()
    ws = null
  },

  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
    console.log('eval runs arbitrary JS in the renderer, e.g.:')
    console.log(`  eval (async()=>{const m=await import('/src/renderer/state/projectStore.ts');return m.useProjectStore.getState().project.name})()`)
  }
}

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

// Piped-in commands arrive as a burst of 'line' events before any async handler for an
// earlier line has resolved — queue them so e.g. `launch` always finishes before the next
// command (like `screenshot`) that depends on it runs.
let queue = Promise.resolve()

rl.on('line', (line) => {
  queue = queue.then(async () => {
    const sp = line.indexOf(' ')
    const cmd = sp === -1 ? line.trim() : line.slice(0, sp)
    const rest = sp === -1 ? '' : line.slice(sp + 1)
    if (!cmd) return rl.prompt()
    const fn = COMMANDS[cmd]
    if (!fn) {
      console.log('unknown:', cmd, '- try: help')
      return rl.prompt()
    }
    try {
      await fn(rest)
    } catch (e) {
      console.log('ERROR:', e.message)
    }
    if (cmd === 'quit') {
      rl.close()
      process.exit(0)
    }
    rl.prompt()
  })
})
rl.on('close', async () => {
  await COMMANDS.quit()
  process.exit(0)
})

console.log('freecut dev driver — "help" for commands, "launch" to start')
rl.prompt()
