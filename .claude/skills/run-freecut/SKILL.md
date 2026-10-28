---
name: run-freecut
description: Build, run, and drive the freecut Electron app for agent-driven verification (screenshots, live store/DOM inspection). Use when asked to start freecut, screenshot it, or confirm a change works in the real app rather than just typechecking/unit tests.
---

freecut is an Electron + React + Vite desktop app (`npm run dev` for a human;
this skill is the agent path). Drive it via the CDP REPL at
`scripts/devDriver.mjs` — no Accessibility/Screen Recording permissions, no
OS window-id lookups: screenshots go through the DevTools Protocol's own
`Page.captureScreenshot`, which works headless/occluded/unattended.

## Run

```bash
cd /Users/kng/projects/freecut
node scripts/devDriver.mjs
```

`launch` starts `npm run dev` for you if Vite isn't already up, waits for
the Electron debug port, connects over CDP, and settles ~800ms before
returning (so the first screenshot isn't a blank paint). Screenshots land
in `.dev-shots/` (override: `SCREENSHOT_DIR`).

For non-interactive/scripted use, pipe commands in:

```bash
(printf 'launch\nscreenshot home\nquit\n'; sleep 15) | node scripts/devDriver.mjs
```

Commands are queued and run one at a time even when piped in as a burst —
`launch` always finishes before a later `screenshot` that depends on it.

### Commands

| command | what it does |
|---|---|
| `launch` | start (or reuse) Vite + a debug-enabled Electron, connect over CDP |
| `screenshot [name]` | `.dev-shots/<name>.png` via `Page.captureScreenshot` |
| `eval <js>` | evaluate JS in the renderer, print the JSON result |
| `evalFile <path>` | same, but the JS comes from a file (for multi-line scripts) |
| `wait <ms>` | pause (e.g. before screenshotting after a state change) |
| `reload` | `Page.reload` |
| `quit` | close Electron, exit the driver |

### Driving the real app modules from `eval`

The renderer is served by Vite, so `eval`/`evalFile` can `import()` the
actual app modules by their served path and call real store actions —
this is how you create a project, add a clip, or check `effectiveDuration`
without clicking through the UI:

```js
(async () => {
  const projMod = await import('/src/renderer/state/projectStore.ts')
  const store = projMod.useProjectStore
  store.getState().newProject()
  return store.getState().project.name
})()
```

Dialogs that go through `window.api.*` (open/save file pickers) are native
OS dialogs and can't be driven this way — call the underlying store
actions directly instead, or stub `window.confirm`/`window.alert` before
clicking a button that uses them:
```js
window.confirm = () => true // auto-accept, then restore it after
```

## Gotchas

- **`freecut-media://` is the hard-won fix for "nothing plays".** In dev
  mode the renderer loads from `http://localhost:5173`, not `file://`.
  `<video>`/`<audio>` elements loading a plain `file://` src from that
  origin are rejected by Chromium's media URL safety check
  (`MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`) —
  silently killing all preview playback. The fix: `electron/main/index.ts`
  registers a privileged `freecut-media://` scheme backed by `net.fetch`
  (which also gives free Range-request support for scrubbing), and
  `electron/preload/index.ts`'s `fileUrl()` emits that scheme instead of
  `file://`. If preview playback breaks again, check this wiring first
  before suspecting the player code in `Preview.tsx`.
- **Two Electron instances can coexist.** `launch` doesn't kill any
  already-running freecut window; it just starts its own debug-enabled
  one pointed at the same (possibly-already-running) Vite dev server.
  Kill stray instances with
  `pkill -f "freecut-editor|Electron.app/Contents/MacOS/Electron|node_modules/.bin/vite"`
  if things get confusing.
- **Killing the Electron child can kill Vite too** (they're tied together
  via `vite-plugin-electron`'s process lifecycle under `npm run dev`). If
  a screenshot suddenly shows a blank/error page, check
  `curl -sI http://localhost:5173/` and restart `npm run dev` if it's
  down, rather than assuming the app broke.
- **`document.hidden`/`requestAnimationFrame` throttling**: if the macOS
  screen is locked or the window is fully occluded, the renderer's rAF
  loop (which drives both playback time advancement and canvas rendering
  in `Preview.tsx`) can stall or stop entirely — not a bug, just the
  browser's background-tab throttling. Don't debug "playback not
  advancing" without first checking `document.hidden` via `eval`.

## Verification patterns used across this codebase

- `npx tsc -p tsconfig.json --noEmit` — typecheck.
- `npx vitest run` — pure-function unit tests (`src/shared/*.test.ts`):
  the speed/transform/piecewise-expression math belongs here, not in
  ffmpeg/Electron smoke tests.
- `npx tsx scripts/testExport.ts` (or `npm run test:export`) — builds a
  synthetic `Project` object, runs the real `buildFfmpegPlan`, spawns the
  real `ffmpeg-static` binary, and probes the output. This is the
  established way to verify an `ffmpegGraph.ts` change actually produces
  a working export, not just a plausible-looking filter string.
- This driver — for anything that needs to be seen (preview rendering,
  Inspector controls, Timeline interaction) or needs live store state
  inspected mid-session.
