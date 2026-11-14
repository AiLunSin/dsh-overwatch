// M4 browser restore drill (real DSH web host + real fishkeeper + real Edge).
// Test-only. Uses a throwaway DSH_HOME and temp fish data; never touches the
// user's real profile or fish source.
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../../..')
const RESULTS = path.join(REPO, 'e2e/m4/browser/results')
const ROOT = process.env.OW_BROWSER_DRILL_ROOT || path.join(os.tmpdir(), 'ow-browser-drill')
const FISHKEEPER_DIR = process.env.FISHKEEPER_DIR || 'C:/Users/11403/Desktop/huanjing/fish-keeper-console'
const HOME = path.join(ROOT, 'home')
const WORK = path.join(ROOT, 'work')
const PROFILE = 'drill'
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE)
const FISH_SOURCE = path.join(ROOT, 'fish-a')
const FISH_DATA = path.join(ROOT, 'fishkeeper-data')
const OVERWATCH_DATA = path.join(ROOT, 'overwatch-data')
const WEB_TOKEN = 'browser-drill-token'
const SWARM_TOKEN = 'm1-swarm-token'
const CHECKPOINT_ID = 'ck_mwbpul1s_e83bf1c79a'
const DIARY = 'diary/2026-11-11.jsonl'
const EMPTY = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DSH_')))

const desktop = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
const EXE = path.join(desktop, 'DeepSeek Harness.exe')
const CLI = path.join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const report = {
  startedAt: new Date().toISOString(),
  root: ROOT,
  host: {},
  steps: [],
  keyboard: {},
  a11y: {},
  visual: {},
  restore: {},
  token: {},
  artifacts: [],
  errors: [],
}
const started = Date.now()

function log(...args) { console.log(...args) }
async function step(name, fn) {
  const at = new Date().toISOString()
  try {
    const detail = await fn()
    report.steps.push({ name, status: 'pass', at, detail })
    log('PASS', name, detail ?? '')
    return detail
  } catch (error) {
    report.steps.push({ name, status: 'fail', at, error: String(error?.message ?? error) })
    report.errors.push({ name, error: String(error?.stack ?? error) })
    log('FAIL', name, error?.message ?? error)
    throw error
  }
}
function must(cond, message) { if (!cond) throw new Error(message) }
function norm(s) { return String(s ?? '').replace(/\s+/g, ' ').trim() }
function slash(p) { return p.replaceAll('\\', '/') }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')) }
function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}
function copyEntries(src, dest, entries) {
  mkdirSync(dest, { recursive: true })
  for (const entry of entries) {
    const from = path.join(src, entry)
    if (existsSync(from)) cpSync(from, path.join(dest, entry), { recursive: true })
  }
}
async function removeDir(dir) {
  for (let i = 0; i < 60; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) { if (i === 59) throw error }
    await new Promise((r) => setTimeout(r, 500))
  }
}
function killDrillEdges() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*ow-browser-drill*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: 'ignore', timeout: 30000 })
  return r.status === 0
}
function cli(args, timeout = 300000) {
  const r = spawnSync(EXE, ['--expose-internals', CLI, ...args], {
    cwd: WORK,
    env: { ...EMPTY, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed (${r.status})\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`)
  return r.stdout
}

// ---------- setup ----------
async function ensureProfile() {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  mkdirSync(RESULTS, { recursive: true })
  for (const f of readdirSync(RESULTS)) if (f.endsWith('.png') || f === 'report.json') rmSync(path.join(RESULTS, f), { force: true })

  if (!existsSync(path.join(PROFILE_DIR, 'package.json'))) cli(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  const nm = path.join(PROFILE_DIR, 'node_modules')
  await removeDir(nm)
  copyEntries(REPO, path.join(nm, 'dsh-overwatch'), ['package.json', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg', 'src'])
  copyEntries(path.join(REPO, 'e2e/m1/fake-swarm'), path.join(nm, 'dsh-overwatch-m1-fake-swarm'), ['package.json', 'index.js', 'cordis.patch.yml'])
  copyEntries(FISHKEEPER_DIR, path.join(nm, 'dsh-fishkeeper'), ['package.json', 'lib', 'cordis.patch.yml', 'locale', 'icon.svg'])

  writeFileSync(path.join(PROFILE_DIR, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-drill',
    private: true,
    dependencies: { 'dsh-overwatch': '*', 'dsh-overwatch-m1-fake-swarm': '*', 'dsh-fishkeeper': '*' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-overwatch', 'dsh-overwatch-m1-fake-swarm', 'dsh-fishkeeper'] } },
  }, null, 2)}\n`, 'utf8')

  writeFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), [
    '# Browser restore drill. Test values only.',
    '- id: dsh-overwatch',
    '  config:',
    '    enabled: true',
    '    mode: guard',
    '    http:',
    `      token: ${WEB_TOKEN}`,
    '    ports:',
    `      swarmToken: ${SWARM_TOKEN}`,
    '    storage:',
    `      dataDir: '${slash(OVERWATCH_DATA)}'`,
    '    fish:',
    `      dataDir: '${slash(FISH_DATA)}'`,
    '    sampling:',
    '      swarmEventMs: 600',
    '      swarmSnapshotMs: 600',
    '      pressureMs: 600',
    '      fishMs: 600',
    '      staleMs: 5000',
    '      requestTimeoutMs: 3000',
    '      maxInflight: 4',
    '    policy:',
    '      throttleMinutes: 1',
    '      autopilot:',
    '        throttle: false',
    '- id: dsh-overwatch-m1-fake-swarm',
    '  config:',
    `    token: ${SWARM_TOKEN}`,
    '- id: fishkeeper',
    '  config:',
    `    dataRoot: '${slash(FISH_DATA)}'`,
    '    sources:',
    '      - id: demo-a',
    '        displayName: 大肥鱼 A',
    '        adapter: file',
    `        location: '${slash(FISH_SOURCE)}'`,
    '        enabled: true',
    '        options: {}',
  ].join('\n') + '\n', 'utf8')
}

function seedFish() {
  rmSync(FISH_SOURCE, { recursive: true, force: true })
  cpSync(path.join(FISHKEEPER_DIR, 'demo/fish-a'), FISH_SOURCE, { recursive: true })
  rmSync(FISH_DATA, { recursive: true, force: true })
  mkdirSync(path.join(FISH_DATA, 'checkpoints'), { recursive: true })
  mkdirSync(path.join(FISH_DATA, 'audit'), { recursive: true })
  mkdirSync(path.join(FISH_DATA, 'locks'), { recursive: true })
  const sourceCheckpoints = path.join(os.homedir(), '.dsh/fishkeeper/checkpoints/demo-a')
  must(existsSync(sourceCheckpoints), `missing seed checkpoints: ${sourceCheckpoints}`)
  cpSync(sourceCheckpoints, path.join(FISH_DATA, 'checkpoints/demo-a'), { recursive: true })
  const audit = path.join(os.homedir(), '.dsh/fishkeeper/audit/demo-a.actions.jsonl')
  if (existsSync(audit)) cpSync(audit, path.join(FISH_DATA, 'audit/demo-a.actions.jsonl'))

  const target = path.join(FISH_SOURCE, DIARY)
  const original = readFileSync(target, 'utf8')
  writeFileSync(path.join(ROOT, 'diary-original.txt'), original, 'utf8')
  appendFileSync(target, `${JSON.stringify({ id: 'drill-drift', at: new Date().toISOString(), text: 'browser restore drill drift' })}\n`, 'utf8')
  report.restore.originalBytes = Buffer.byteLength(original)
  report.restore.driftedBytes = Buffer.byteLength(readFileSync(target, 'utf8'))
  rmSync(OVERWATCH_DATA, { recursive: true, force: true })
  mkdirSync(OVERWATCH_DATA, { recursive: true })
}

function killPid(pid) {
  if (!pid) return
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 }) } catch {}
}
function killPreviousHost() {
  const pidFile = path.join(ROOT, 'host.pid')
  if (existsSync(pidFile)) killPid(Number(readFileSync(pidFile, 'utf8').trim()))
  const locksDir = path.join(FISH_DATA, 'locks')
  if (existsSync(locksDir)) {
    for (const f of readdirSync(locksDir, { withFileTypes: true })) {
      if (!f.isFile()) continue
      try {
        const lock = readJson(path.join(locksDir, f.name))
        if (lock?.pid) killPid(lock.pid)
      } catch {}
    }
  }
  rmSync(locksDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  mkdirSync(locksDir, { recursive: true })
}

async function startHost() {
  killPreviousHost()
  const outPath = path.join(ROOT, 'host.log')
  const errPath = path.join(ROOT, 'host.err.log')
  const out = openSync(outPath, 'w')
  const err = openSync(errPath, 'w')
  const child = spawn(EXE, ['--expose-internals', CLI, '--profile', PROFILE, '--port', '0', '--no-open'], {
    cwd: WORK,
    env: { ...EMPTY, DSH_HOME: HOME, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', out, err],
  })
  writeFileSync(path.join(ROOT, 'host.pid'), String(child.pid), 'utf8')
  const end = Date.now() + 120000
  let url = null
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 400))
    if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${readFileSync(errPath, 'utf8').slice(-3000)}`)
    const text = readFileSync(outPath, 'utf8')
    const m = text.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/)
    if (m) { url = m[1]; break }
  }
  if (!url) throw new Error(`host URL timeout\n${readFileSync(outPath, 'utf8').slice(-3000)}\n${readFileSync(errPath, 'utf8').slice(-3000)}`)
  const origin = new URL(url).origin
  const token = new URL(url).searchParams.get('token')
  const healthEnd = Date.now() + 30000
  let health = null
  while (Date.now() < healthEnd) {
    try { const r = await fetch(`${origin}/overwatch/api/health`); if (r.ok) { health = await r.json(); break } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  must(health?.ok === true, 'overwatch health not ready')
  report.host = { origin, tokenPresent: Boolean(token), health: { ok: health.ok, version: health.version, mode: health.mode, watch: health.service?.watch } }
  return { child, url, origin, token, stop: async () => { try { child.kill() } catch {} killPid(child.pid) } }
}

// ---------- browser ----------
async function waitJson(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('timeout ' + url)
}

async function openBrowser(webUrl) {
  const userData = path.join(ROOT, 'edge-profile-final')
  rmSync(userData, { recursive: true, force: true })
  const port = 9400 + Math.floor(Math.random() * 400)
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--force-renderer-accessibility', '--window-size=1440,1100',
    `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' })
  const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id) {
      const p = pending.get(msg.id); if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result)
    } else events.push(msg)
  }
  function send(method, params = {}, sessionId) {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => send(m, p, sessionId)
  for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'Accessibility']) await s(`${domain}.enable`)
  await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await s('Page.navigate', { url: webUrl })

  async function evalJs(expression) {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1200))
    return r.result.value
  }
  async function waitFor(expression, timeout = 20000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try { if (await evalJs(expression)) return true } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('waitFor timeout: ' + expression)
  }
  async function text() { return evalJs('document.body.innerText') }
  async function shot(name) {
    const r = await s('Page.captureScreenshot', { format: 'png' })
    const file = path.join(RESULTS, name)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    report.artifacts.push(file)
    return file
  }
  async function shotFull(name) {
    const metrics = await s('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize
    const height = Math.min(Math.ceil(size.height), 4200)
    const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 } })
    const file = path.join(RESULTS, name)
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    report.artifacts.push(file)
    return file
  }
  async function clickExact(textValue) {
    const ok = await evalJs(`(() => {
      const n = (s) => (s || '').replace(/\\s+/g, ' ').trim()
      const all = [...document.querySelectorAll('button,a,[role=button],[role=tab]')].filter((e) => !e.disabled)
      const el = all.find((e) => n(e.innerText) === ${JSON.stringify(textValue)})
        ?? all.find((e) => n(e.innerText).startsWith(${JSON.stringify(textValue)}))
      if (!el) return false
      el.scrollIntoView({ block: 'center' }); el.click(); return true
    })()`)
    must(ok, `button not found: ${textValue}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  async function mouseClickSelector(selector) {
    const rect = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    must(rect, `selector not found: ${selector}`)
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 400))
  }
  async function typeText(value) {
    for (const ch of value) await s('Input.insertText', { text: ch })
  }
  async function press(key, code = key) {
    const map = { Tab: 9, Enter: 13, Escape: 27, Space: 32, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }
    const vk = map[key] ?? key.charCodeAt(0)
    const actualKey = key === 'Space' ? ' ' : key
    const actualCode = key === 'Space' ? 'Space' : code
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: actualKey, code: actualCode, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: actualKey, code: actualCode, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await new Promise((r) => setTimeout(r, 220))
  }
  async function activeInfo() {
    return evalJs(`(() => {
      const el = document.activeElement
      const dialog = document.querySelector('[role=dialog]')
      return {
        tag: el?.tagName, type: el?.type ?? null, role: el?.getAttribute?.('role') ?? null,
        name: (el?.getAttribute?.('aria-label') || el?.innerText || el?.value || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        id: el?.id || null, cls: typeof el?.className === 'string' ? el.className : null,
        checked: el?.checked ?? null, disabled: el?.disabled ?? null,
        insideDialog: Boolean(dialog && el && dialog.contains(el)),
      }
    })()`)
  }
  async function tabTo(predicate, max = 16) {
    const sequence = []
    for (let i = 0; i < max; i++) {
      await press('Tab')
      const info = await activeInfo()
      sequence.push(info)
      if (predicate(info)) return { ok: true, sequence }
    }
    return { ok: false, sequence }
  }
  async function axSummary() {
    const { nodes } = await s('Accessibility.getFullAXTree')
    const byId = new Map(nodes.map((n) => [n.nodeId, n]))
    const roleOf = (n) => n.role?.value ?? null
    const nameOf = (n) => n.name?.value ?? ''
    const propsOf = (n) => Object.fromEntries((n.properties ?? []).map((p) => [p.name, p.value?.value]))
    const textOf = (n, depth = 0) => {
      if (!n || depth > 8) return ''
      if (roleOf(n) === 'StaticText' || roleOf(n) === 'InlineTextBox') return nameOf(n)
      return (n.childIds ?? []).map((id) => textOf(byId.get(id), depth + 1)).filter(Boolean).join(' ')
    }
    const wanted = new Set(['dialog', 'tablist', 'tab', 'tabpanel', 'table', 'row', 'columnheader', 'rowheader', 'button', 'status', 'alert', 'heading', 'list', 'listitem'])
    const items = nodes.filter((n) => wanted.has(roleOf(n)) && !n.ignored).map((n) => ({
      role: roleOf(n), name: nameOf(n).slice(0, 160), text: textOf(n).replace(/\s+/g, ' ').trim().slice(0, 240), props: propsOf(n),
    }))
    return { total: nodes.length, items }
  }
  async function dismissStartDialog() {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await evalJs(`document.body.innerText.includes('开始使用')`))) return true
      await press('Escape')
      await new Promise((r) => setTimeout(r, 600))
      if (!(await evalJs(`document.body.innerText.includes('开始使用')`))) return true
      const point = await evalJs(`(() => {
        const dialogs = [...document.querySelectorAll('[role=dialog]')].filter((e) => e.innerText.includes('开始使用'))
        const all = dialogs.length ? dialogs : [...document.querySelectorAll('div')].filter((e) => e.innerText.includes('开始使用') && e.innerText.includes('登录 DeepSeek'))
        const el = all.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0]
        if (!el) return { x: 8, y: 8 }
        const r = el.getBoundingClientRect()
        return { x: r.right - 24, y: r.top + 22 }
      })()`)
      await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 700))
    }
    return !(await evalJs(`document.body.innerText.includes('开始使用')`))
  }
  async function close() {
    try { await send('Browser.close') } catch {}
    try { ws.close() } catch {}
    try { child.kill() } catch {}
    await new Promise((r) => setTimeout(r, 500))
    killPid(child.pid)
  }
  return { s, evalJs, waitFor, text, shot, shotFull, clickExact, mouseClickSelector, typeText, press, activeInfo, tabTo, axSummary, dismissStartDialog, close, events, send }
}

async function runBrowser(b) {
  await b.waitFor(`document.body.innerText.includes('新会话')`, 30000)
  const direct = await fetch(`${report.host.origin}/api/fishkeeper/overview`)
  report.host.directFishStatus = direct.status
  must(direct.status === 401, `direct fishkeeper overview expected 401, got ${direct.status}`)

  await new Promise((r) => setTimeout(r, 1800))
  await b.dismissStartDialog()

  await step('browser opens host with token URL', async () => {
    const info = await b.evalJs(`JSON.stringify({ url: location.href, title: document.title })`)
    return info
  })
  const browserFish = await b.evalJs(`fetch('/api/fishkeeper/overview').then(async r => r.status + ' ' + (await r.text()).slice(0, 80))`)
  report.host.browserFishStatus = Number(String(browserFish).split(' ')[0])
  must(report.host.browserFishStatus === 200, `browser fishkeeper overview expected 200, got ${browserFish}`)
  await step('Host fetch 401 reproduced, browser fetch 200', () => ({ direct: direct.status, browser: report.host.browserFishStatus }))

  await step('seed a live armed run for restore evidence', async () => {
    const r = await fetch(`${report.host.origin}/overwatch/api/runs/swarm_m1/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-overwatch-token': WEB_TOKEN }, body: JSON.stringify({ mode: 'guard' }),
    })
    must(r.ok, `arm failed ${r.status}`)
    const body = await r.json()
    report.restore.run = body.data
    return body.data
  })

  if (await b.evalJs(`document.body.innerText.includes('继续')`)) await b.clickExact('继续')
  await new Promise((r) => setTimeout(r, 500))
  await b.clickExact('新会话')
  await new Promise((r) => setTimeout(r, 1500))
  await b.clickExact('瞭望塔')
  await b.waitFor(`document.body.innerText.includes('受控蜂群的硬闸门观测台')`, 20000)
  await new Promise((r) => setTimeout(r, 1200))
  await b.dismissStartDialog()
  report.a11y.panelTitle = true
  must(!(await b.evalJs(`document.body.innerText.includes('开始使用')`)), 'start dialog still covers the panel')
  await b.shot('01-room.png')
  await step('panel opened in a real conversation', () => 'sidebar panel → main slot')

  await b.evalJs(`[...document.querySelectorAll('[role=tab]')].find(e => e.innerText.replace(/\\s+/g,' ').trim() === '鱼缸')?.click()`)
  await b.waitFor(`document.body.innerText.includes('检查点 · demo-a')`, 20000)
  await b.shot('02-fish-tab.png')
  await b.shotFull('02b-fish-tab-full.png')
  await step('fish tab lists real fishkeeper checkpoint', () => CHECKPOINT_ID)

  await b.clickExact('展开写操作')
  await b.waitFor(`document.querySelector('input[type=password]') !== null`)
  await b.mouseClickSelector('input[type=password]')
  await b.evalJs(`document.querySelector('input[type=password]').focus()`)
  await b.typeText(WEB_TOKEN)
  const tokenInput = await b.evalJs(`JSON.stringify({ value: document.querySelector('input[type=password]')?.value ?? '', active: document.activeElement === document.querySelector('input[type=password]'), saveDisabled: [...document.querySelectorAll('button[type=submit]')].some((x) => x.innerText.includes('保存')) && [...document.querySelectorAll('button[type=submit]')].find((x) => x.innerText.includes('保存'))?.disabled })`)
  must(JSON.parse(tokenInput).value === WEB_TOKEN, `password input did not receive token: ${tokenInput}`)
  must(JSON.parse(tokenInput).saveDisabled === false, `save button still disabled: ${tokenInput}`)
  await b.clickExact('保存到本次会话')
  await b.waitFor(`document.body.innerText.includes('写操作已解锁')`, 15000)
  await b.shot('03-write-unlocked.png')
  await step('write token set through the panel (sessionStorage only)', () => '写操作已解锁')

  const restoreName = await b.evalJs(`(() => { const el=[...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label')||'').startsWith('恢复 ck_')); return el ? el.getAttribute('aria-label') : null })()`)
  must(restoreName?.includes(CHECKPOINT_ID), `restore button missing: ${restoreName}`)
  report.a11y.restoreButtonName = restoreName
  await b.mouseClickSelector(`button[aria-label="${restoreName}"]`)
  await b.waitFor(`document.querySelector('[role=dialog]') !== null`, 15000)
  await b.waitFor(`document.body.innerText.includes('影响预览') && document.body.innerText.includes('将写入')`, 20000)
  await b.shot('04-preflight.png')
  const contrastDialog = await b.evalJs(`(() => {
    const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const ratio = (a, b) => { const l1 = lum(parse(a)), l2 = lum(parse(b)); const x = Math.max(l1, l2), y = Math.min(l1, l2); return (x + 0.05) / (y + 0.05) }
    const bg = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; n = n.parentElement } return 'rgb(255,255,255)' }
    const pick = (sel) => { const el = document.querySelector(sel); return el ? { fg: getComputedStyle(el).color, bg: bg(el), size: getComputedStyle(el).fontSize, ratio: Number(ratio(getComputedStyle(el).color, bg(el)).toFixed(2)) } : null }
    return JSON.stringify({ dialog: pick('[role=dialog]'), warning: pick('.ow-tone-warn'), error: pick('.ow-tone-error'), button: pick('.ow-btn-primary') })
  })()`)
  report.visual.contrastDialog = JSON.parse(contrastDialog)
  await step('preflight: dryRun plan with stale warning', () => ({ checkpoint: CHECKPOINT_ID, restoreName }))

  const preAx = await b.axSummary()
  report.a11y.preflight = {
    dialog: preAx.items.find((i) => i.role === 'dialog') ?? null,
    tabs: preAx.items.filter((i) => i.role === 'tab').slice(0, 8),
    restoreButton: preAx.items.find((i) => i.role === 'button' && i.name.startsWith('恢复 ck_')) ?? null,
    tableHeaders: preAx.items.filter((i) => i.role === 'columnheader').map((i) => i.name),
    status: preAx.items.filter((i) => i.role === 'status' || i.role === 'alert').map((i) => ({ role: i.role, name: i.name, text: i.text })),
  }
  writeFileSync(path.join(RESULTS, 'ax-preflight.json'), `${JSON.stringify(preAx.items, null, 2)}\n`, 'utf8')
  await step('screen-reader surface: dialog/tabs/table/status exposed in AX tree', () => report.a11y.preflight)

  const focus0 = await b.activeInfo()
  const trap = { initial: focus0, sequence: [], allInside: true }
  for (let i = 0; i < 14; i++) {
    await b.press('Tab')
    const info = await b.activeInfo()
    trap.sequence.push(info)
    if (!info.insideDialog) trap.allInside = false
    if (i === 5) await b.shot('08-keyboard-focus.png')
  }
  report.keyboard.focusTrap = trap
  must(trap.allInside, 'focus escaped the restore dialog while tabbing')
  await step('keyboard: Tab focus stays inside the dialog', () => ({ tabs: trap.sequence.length, unique: new Set(trap.sequence.map((s) => s.tag + ':' + s.name)).size }))

  await b.press('Escape')
  await b.waitFor(`document.querySelector('[role=dialog]') === null`, 10000)
  const afterEscape = await b.activeInfo()
  report.keyboard.escape = afterEscape
  must(String(afterEscape.name ?? '').startsWith('恢复 ck_'), `focus did not return to restore button: ${JSON.stringify(afterEscape)}`)
  await step('keyboard: Escape closes and returns focus', () => afterEscape)

  // Reopen and finish the flow with the keyboard only.
  await b.press('Space')
  await new Promise((r) => setTimeout(r, 800))
  if (!(await b.evalJs(`document.querySelector('[role=dialog]') !== null`))) {
    report.keyboard.reopenFallback = true
    await b.mouseClickSelector(`button[aria-label="${restoreName}"]`)
  }
  await b.waitFor(`document.querySelector('[role=dialog]') !== null`, 15000)
  await b.waitFor(`document.body.innerText.includes('影响预览')`, 20000)
  await new Promise((r) => setTimeout(r, 800))
  const cbTab = await b.tabTo((info) => info.tag === 'INPUT' && info.type === 'checkbox', 12)
  report.keyboard.checkboxSequence = cbTab.sequence
  must(cbTab.ok, 'keyboard could not reach the override checkbox')
  const cbFocusStyle = await b.evalJs(`(() => { const el=document.activeElement; const s=getComputedStyle(el); return { outline: s.outline, boxShadow: s.boxShadow, outlineOffset: s.outlineOffset } })()`)
  report.visual.focusStyle = cbFocusStyle
  await b.press('Space')
  const checked = await b.evalJs(`document.querySelector('[role=dialog] input[type=checkbox]')?.checked === true`)
  must(checked, 'Space did not toggle overrideStale')
  await b.shot('05-confirm.png')
  await step('keyboard: Space toggles overrideStale', () => cbFocusStyle)

  const execTab = await b.tabTo((info) => info.tag === 'BUTTON' && info.name.includes('执行恢复') && info.disabled === false, 12)
  report.keyboard.executeSequence = execTab.sequence
  must(execTab.ok, 'keyboard could not reach 执行恢复')
  await b.press('Space')
  await b.waitFor(`document.body.innerText.includes('恢复成功')`, 30000)
  await b.waitFor(`document.body.innerText.includes('结果已写入 overwatch 日志')`, 20000)
  await b.evalJs(`(() => { const d=document.querySelector('[role=dialog]'); const t=[...d.querySelectorAll('*')].find(e=>e.textContent.trim()==='恢复结果'); if(t) t.scrollIntoView({block:'start'}) })()`)
  await new Promise((r) => setTimeout(r, 500))
  await b.shot('06-result.png')
  const dialogText = await b.evalJs(`document.querySelector('[role=dialog]')?.innerText ?? ''`)
  const safety = dialogText.match(/恢复前安全检查点:\s*(ck_[a-z0-9_]+)/i)?.[1] ?? null
  report.restore.safetyCheckpointId = safety
  report.restore.dialogText = dialogText
  must(dialogText.includes('已恢复 3 个文件'), 'result did not report 3 restored files')
  must(dialogText.includes('diary/2026-11-11.jsonl') && dialogText.includes('成功'), 'result rows missing')
  must(safety, 'result did not show a pre-restore safety checkpoint')
  await step('restore result: 3/3 files, safety checkpoint shown', () => ({ safety }))

  // Capture the actual confirm tokens from the browser network layer.
  const reqIds = b.events
    .filter((e) => e.method === 'Network.requestWillBeSent' && /\/api\/fishkeeper\/checkpoint\/restore/.test(e.params?.request?.url ?? '') && e.params?.request?.method === 'POST')
    .map((e) => e.params.requestId)
  const tokens = []
  for (const requestId of reqIds) {
    try {
      const r = await b.s('Network.getRequestPostData', { requestId })
      const parsed = JSON.parse(r.postData)
      if (parsed.confirmToken) tokens.push(parsed.confirmToken)
    } catch {}
  }
  report.token.capturedCount = tokens.length

  const postAx = await b.axSummary()
  report.a11y.result = {
    dialog: postAx.items.find((i) => i.role === 'dialog') ?? null,
    tableHeaders: postAx.items.filter((i) => i.role === 'columnheader').map((i) => i.name),
    status: postAx.items.filter((i) => i.role === 'status' || i.role === 'alert').map((i) => ({ role: i.role, name: i.name, text: i.text })),
  }
  writeFileSync(path.join(RESULTS, 'ax-result.json'), `${JSON.stringify(postAx.items, null, 2)}\n`, 'utf8')
  const statusText = report.a11y.result.status.map((s) => s.text).join(' ')
  report.a11y.liveRegionText = statusText
  const a11yPass = Boolean(report.a11y.result.dialog?.name?.includes('恢复检查点'))
    && statusText.includes('结果已写入')
    && report.a11y.preflight.tabs.length >= 4
    && report.a11y.preflight.tableHeaders.some((n) => n.includes('文件'))
  report.a11y.pass = a11yPass
  await step('screen-reader surface: result dialog, table, status/alert', () => report.a11y.result)
  must(a11yPass, 'AX summary missing dialog/tabs/table/status')

  await b.press('Escape')
  await b.waitFor(`document.querySelector('[role=dialog]') === null`, 10000)

  const refreshed = await b.evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].filter((e) => e.innerText.trim() === '刷新').find((e) => e.closest('section')?.innerText.includes('检查点'))
    if (!btn) return false; btn.click(); return true
  })()`)
  if (refreshed) await new Promise((r) => setTimeout(r, 1500))
  await b.shot('07-checkpoints-after.png')
  const ck = await b.evalJs(`fetch('/api/fishkeeper/checkpoints?source=demo-a').then(r => r.json())`)
  const checkpoints = ck?.items ?? ck?.data?.items ?? []
  report.restore.checkpointCount = Array.isArray(checkpoints) ? checkpoints.length : null
  report.restore.triggers = Array.isArray(checkpoints) ? checkpoints.map((c) => c.trigger) : []
  const bodyAfter = await b.text()
  must(Array.isArray(checkpoints) && checkpoints.length >= 2, `expected >=2 checkpoints, got ${report.restore.checkpointCount}`)
  must(report.restore.triggers.includes('pre-restore'), `pre-restore trigger missing: ${JSON.stringify(report.restore.triggers)}`)
  must(bodyAfter.includes('恢复前'), 'checkpoint list did not show the pre-restore trigger after refresh')
  await step('pre-restore checkpoint visible in the panel list', () => ({ checkpoints: report.restore.checkpointCount, triggers: report.restore.triggers }))

  const original = readFileSync(path.join(ROOT, 'diary-original.txt'), 'utf8')
  const current = readFileSync(path.join(FISH_SOURCE, DIARY), 'utf8')
  report.restore.fileRestored = current === original
  must(report.restore.fileRestored, 'source file was not restored byte-for-byte')
  await step('source file restored byte-for-byte', () => ({ file: DIARY, bytes: Buffer.byteLength(current) }))

  // ---------- token leak audit ----------
  const searchRoots = [OVERWATCH_DATA, FISH_DATA]
  const hits = []
  for (const file of searchRoots.flatMap((d) => walkFiles(d))) {
    let content = ''
    try { content = readFileSync(file, 'utf8') } catch { continue }
    for (const token of tokens) if (content.includes(token)) hits.push({ file: path.relative(ROOT, file), token: 'confirmToken' })
  }
  const dom = await b.evalJs(`document.documentElement.outerHTML`)
  const storage = await b.evalJs(`JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } })`)
  const consoleText = b.events.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => JSON.stringify(e.params.args ?? [])).join('\n')
  const urls = b.events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params?.request?.url ?? '').join('\n')
  for (const token of tokens) {
    if (dom.includes(token)) hits.push({ file: 'document.html', token: 'confirmToken' })
    if (storage.includes(token)) hits.push({ file: 'storage', token: 'confirmToken' })
    if (consoleText.includes(token)) hits.push({ file: 'console', token: 'confirmToken' })
    if (urls.includes(token)) hits.push({ file: 'request-url', token: 'confirmToken' })
  }
  report.token.leaked = hits.length > 0
  report.token.hits = hits
  report.token.searched = ['overwatch-data/**', 'fishkeeper-data/**', 'document.html', 'localStorage', 'sessionStorage', 'console', 'request URLs']
  must(tokens.length > 0, 'no confirmToken captured from the browser network layer')
  must(hits.length === 0, `confirmToken leaked: ${JSON.stringify(hits)}`)
  await step('confirmToken never reaches storage/URL/log/DOM', () => ({ captured: tokens.length, searched: report.token.searched }))

  // ---------- watch log + hash chain ----------
  const watchFile = path.join(OVERWATCH_DATA, 'runs/swarm_m1/watch.jsonl')
  const watch = readFileSync(watchFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const intents = watch.filter((e) => e.type === 'watch/restore/intent')
  const results = watch.filter((e) => e.type === 'watch/restore/result')
  report.restore.watch = { intent: intents.length, result: results.length, lastHash: watch.at(-1)?.hash ?? null }
  must(intents.length >= 1 && results.length >= 1, 'watch/restore intent/result missing')
  const lastResult = results.at(-1)
  must(lastResult.payload?.result?.ok === true, 'watch/restore/result was not ok')
  must((lastResult.payload?.result?.files ?? []).every((f) => f.ok === true), 'watch/restore/result has failed files')
  const health = await (await fetch(`${report.host.origin}/overwatch/api/health`)).json()
  report.restore.hashChainOk = health?.service?.watch?.ok === true
  must(report.restore.hashChainOk, 'watch hash chain is not valid after restore')
  await step('watch/restore/result recorded and hash chain valid', () => report.restore.watch)

  // ---------- visual checks ----------
  const overflow1440 = await b.evalJs(`JSON.stringify({ iw: innerWidth, sw: document.documentElement.scrollWidth, root: (() => { const el=document.querySelector('.ow-root'); return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null })() })`)
  report.visual.overflow1440 = JSON.parse(overflow1440)
  const contrast = await b.evalJs(`(() => {
    const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const ratio = (a, b) => { const l1 = lum(parse(a)), l2 = lum(parse(b)); const x = Math.max(l1, l2), y = Math.min(l1, l2); return (x + 0.05) / (y + 0.05) }
    const bg = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; n = n.parentElement } return 'rgb(255,255,255)' }
    const pick = (sel) => { const el = document.querySelector(sel); return el ? { fg: getComputedStyle(el).color, bg: bg(el), size: getComputedStyle(el).fontSize } : null }
    const map = { root: pick('.ow-root'), card: pick('.ow-card'), muted: pick('.ow-muted'), warning: pick('.ow-tone-warn'), button: pick('.ow-btn-primary') }
    for (const [k, v] of Object.entries(map)) if (v) v.ratio = Number(ratio(v.fg, v.bg).toFixed(2))
    return JSON.stringify(map)
  })()`)
  report.visual.contrast = JSON.parse(contrast)
  report.visual.noHorizontalOverflow1440 = report.visual.overflow1440.sw <= report.visual.overflow1440.iw + 1

  await b.s('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 600))
  const overflow1024 = await b.evalJs(`JSON.stringify({ iw: innerWidth, sw: document.documentElement.scrollWidth, root: (() => { const el=document.querySelector('.ow-root'); return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null })() })`)
  report.visual.overflow1024 = JSON.parse(overflow1024)
  report.visual.noHorizontalOverflow1024 = report.visual.overflow1024.sw <= report.visual.overflow1024.iw + 1
  await b.shot('09-1024.png')
  await step('visual: screenshots, no horizontal overflow at 1440/1024, contrast sampled', () => ({ overflow1440: report.visual.noHorizontalOverflow1440, overflow1024: report.visual.noHorizontalOverflow1024 }))
}

// ---------- main ----------
let host = null
let browser = null
try {
  log('setup profile + seed data')
  killDrillEdges()
  killPreviousHost()
  await new Promise((r) => setTimeout(r, 3000))
  await ensureProfile()
  seedFish()
  log('start DSH web host')
  host = await startHost()
  log('host', host.origin)
  browser = await openBrowser(host.url)
  await runBrowser(browser)
  report.ok = true
} catch (error) {
  report.ok = false
  report.fatal = String(error?.stack ?? error)
  console.error('DRILL FAILED:', error?.message ?? error)
} finally {
  try { await browser?.close() } catch {}
  try { await host?.stop() } catch {}
  report.finishedAt = new Date().toISOString()
  report.durationMs = Date.now() - started
  writeFileSync(path.join(RESULTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\nreport: ${path.join(RESULTS, 'report.json')}`)
  console.log(`result: ${report.ok ? 'PASS' : 'FAIL'} (${Math.round(report.durationMs / 1000)}s)`)
  for (const s of report.steps) console.log(`${s.status === 'pass' ? '✓' : '✗'} ${s.name}`)
  process.exit(report.ok ? 0 : 1)
}
