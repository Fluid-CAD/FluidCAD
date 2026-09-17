// Capture the sidebar tutorials through the local viewer's real rendering API.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node website/scripts/capture-landing.mjs
// Start ../FluidCAD-Viewer first. VIEWER_URL and ENGINE_VERSION may be overridden.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const viewer = process.env.VIEWER_URL || 'http://localhost:8788'
const version = process.env.ENGINE_VERSION || 'dev'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader']
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.route(`${viewer}/landing-capture`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      },
      body: '<!doctype html><html><body></body></html>'
    })
  )
  await page.goto(`${viewer}/landing-capture`)
  await page.evaluate(
    ({ viewer, version }) => {
      window.events = []
      window.addEventListener('message', (event) => {
        if (event.data?.channel === 'fluidcad-viewer') window.events.push(event.data)
      })
      const frame = document.createElement('iframe')
      frame.style = 'width:1100px;height:800px;border:0'
      frame.src = `${viewer}/#v=${version}&chrome=none&theme=light&grid=0&axes=0&connectors=0&view=5,-5,4&fit=tight&fit-padding=1.15`
      document.body.append(frame)
      window.send = (body) =>
        frame.contentWindow.postMessage({ channel: 'fluidcad-viewer', v: 1, ...body }, viewer)
    },
    { viewer, version }
  )
  await page.waitForFunction(
    () => window.events.some((e) => e.type === 'ready' && e.viewport),
    null,
    { timeout: 120000 }
  )
  const frame = page.frames().find((frame) => frame !== page.mainFrame())
  await frame.evaluate(() =>
    window.__viewerClient.onScene(({ outcome }) => {
      window.captureErrors = outcome.objectErrors
    })
  )
  const requested = process.argv.slice(2)
  const examples = [
    'lantern',
    'upper-alignment-clamp',
    'flange-with-notch',
    'desk-organizer',
    'fork'
  ]
  for (const id of examples.filter((id) => !requested.length || requested.includes(id))) {
    let code = await readFile(resolve(`website/docs/tutorials/_examples/${id}-final.js`), 'utf8')
    if (id === 'flange-with-notch') {
      // Capture-only workaround: the current engine fails to resolve the pipe's
      // end-face accessor after auto-fusion. Use the same top plane, derived
      // from the tutorial's two extrusion heights. Keep the tutorial untouched.
      const baseHeight = code.match(/const flange = extrude\((\d+)\)/)?.[1]
      const pipeHeight = code.match(/const pipe = extrude\((\d+)\)/)?.[1]
      if (!baseHeight || !pipeHeight || !code.includes('sketch(pipe.endFaces(),')) {
        throw new Error('Flange source changed; review its capture datum')
      }
      code = code
        .replace('origin, sketch', 'origin, plane, sketch')
        .replace('sketch(pipe.endFaces(),', `sketch(plane("xy", ${baseHeight} + ${pipeHeight}),`)
    }
    await page.evaluate(
      ({ code, id }) => {
        window.events = []
        const entry = id + '.fluid.js'
        window.send({ type: 'load', model: { entry, files: { [entry]: code } } })
      },
      { code, id }
    )
    await page.waitForFunction(
      (id) =>
        window.events.some(
          (e) => (e.type === 'scene' && e.entry === id + '.fluid.js') || e.type === 'error'
        ),
      id,
      { timeout: 120000 }
    )
    const event = await page.evaluate(
      (id) =>
        window.events.find(
          (e) => (e.type === 'scene' && e.entry === id + '.fluid.js') || e.type === 'error'
        ),
      id
    )
    if (event.type === 'error' || event.compileError || event.objectErrors) {
      const errors = await frame.evaluate(() => window.captureErrors)
      throw new Error(`${id}: ${JSON.stringify(event)}\n${JSON.stringify(errors)}`)
    }
    await page.waitForTimeout(1000)
    const png = await page.evaluate(async () => {
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Screenshot timed out')), 30000)
        const listener = async (event) => {
          const msg = event.data
          if (msg?.channel !== 'fluidcad-viewer' || msg.type !== 'result' || msg.id !== 99) return
          clearTimeout(timer)
          window.removeEventListener('message', listener)
          if (!msg.ok) return reject(new Error(msg.error))
          resolve(Array.from(new Uint8Array(await msg.value.arrayBuffer())))
        }
        window.addEventListener('message', listener)
      })
      window.send({
        type: 'screenshot',
        id: 99,
        options: {
          width: 1400,
          height: 1100,
          pixelRatio: 2,
          transparent: true,
          showGrid: false,
          showAxes: false,
          showConnectors: false,
          showDimensions: false,
          showPositional: false,
          fitToModel: true,
          autoCrop: true,
          margin: 60,
          view: { kind: 'named', name: 'iso-ftr' }
        }
      })
      return result
    })
    await writeFile(resolve(`website/static/img/landing/gallery-${id}.png`), Buffer.from(png))
    console.log(`${id}: captured, ${event.objects} objects, no build errors`)
  }
} finally {
  await browser.close()
}
