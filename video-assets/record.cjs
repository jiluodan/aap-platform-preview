/* eslint-disable no-console */
/**
 * AAP 演示视频录制脚本（自包含，无需 dev server）
 *
 * 通过 file:// 直接打开 video-assets/preview/slideshow.html（已内联全部样式与截图引用），
 * 用 Playwright 录制并导出为 webm。
 * 前置：npm i -D playwright-core，并已安装 Edge 或 Chromium。
 * 运行：
 *   node video-assets/record.cjs            # 完整录制（约 63s）
 *   set QUICK=1 && node video-assets/record.cjs   # 快速验证（8s）
 * 产物：video-assets/aap-walkthrough.webm
 */
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright-core')

const HERE = __dirname
const SHOT_DIR = path.join(HERE, 'screenshots')
const PREVIEW_DIR = path.join(HERE, 'preview')
const OUT_FILE = process.env.OUT ? path.resolve(process.env.OUT) : path.join(HERE, 'aap-walkthrough.webm')
const URL = 'file://' + path.join(HERE, 'preview', 'slideshow.html').replace(/\\/g, '/')

const TOTAL = 60500
const WAIT = process.env.QUICK ? 8000 : TOTAL + 1000

function stage() {
  fs.rmSync(PREVIEW_DIR, { recursive: true, force: true })
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  fs.copyFileSync(path.join(HERE, 'slideshow.html'), path.join(PREVIEW_DIR, 'slideshow.html'))
  for (const f of fs.readdirSync(SHOT_DIR)) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(SHOT_DIR, f), path.join(PREVIEW_DIR, f))
  }
}

;(async () => {
  stage()
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--allow-file-access-from-files'],
  })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: HERE, size: { width: 1600, height: 900 } },
  })
  const page = await context.newPage()
  await page.goto(URL, { waitUntil: 'load' })

  const _errs = []
  page.on('pageerror', e => _errs.push('pageerror: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') _errs.push('console.error: ' + m.text()) })

  let elapsed = 0
  while (elapsed < WAIT) {
    const step = Math.min(5000, WAIT - elapsed)
    await page.waitForTimeout(step)
    elapsed += step
    console.log('recording... ' + Math.round(elapsed / 1000) + 's / ' + Math.round(WAIT / 1000) + 's')
  }

  fs.writeFileSync(path.join(HERE, 'record.err.txt'), _errs.join('\n') || '(no errors)')
  await context.close()
  await browser.close()

  const produced = fs.readdirSync(HERE).filter(f => f.endsWith('.webm') && f !== 'aap-walkthrough.webm')[0]
  if (!produced) throw new Error('no webm produced')
  fs.copyFileSync(path.join(HERE, produced), OUT_FILE)
  fs.rmSync(path.join(HERE, produced), { force: true })
  fs.rmSync(PREVIEW_DIR, { recursive: true, force: true })

  console.log('DONE ' + OUT_FILE + ' (' + (fs.statSync(OUT_FILE).size / 1048576).toFixed(1) + ' MB)')
})().catch(e => {
  console.error('RECORD_FAIL', e)
  try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
