// SVG because the public gateway redirects HTML on /bzz to an approval page but serves SVG inline.

const EXPLORER = 'https://tiramisu.explorer.arkiv.network'

const WIDTH = 960
const LINE_HEIGHT = 18
const TOP_MARGIN = 34
const BOTTOM_MARGIN = 20
const LEFT_MARGIN = 20
const MAX_LINE_CHARS = 100

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const url = (s) => encodeURIComponent(String(s ?? ''))

function truncate(s) {
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s
}

function resolvedBy(state) {
  const id = Object.keys(state.agents).find((agentId) => state.agents[agentId].status === 'done')
  return id ?? null
}

export function renderReceipt(state) {
  const resolver = resolvedBy(state)
  const lines = []

  lines.push({ cls: 'title', text: 'Hydra incident receipt' })
  lines.push({ cls: 'head', text: state.tag })
  lines.push({ cls: 'head', text: resolver ? `Resolved by ${resolver}` : `Phase: ${state.phase}` })
  lines.push({ cls: 'body', text: '' })

  for (const e of state.timeline) {
    const t = new Date(e.at).toISOString().slice(11, 19)
    lines.push({ cls: 'body', text: truncate(`${t}  ${e.agentId}  ${e.text}`) })
  }

  lines.push({ cls: 'body', text: '' })

  const report = state.report
  if (report) {
    lines.push({ cls: 'body', text: truncate(`Arkiv entity ${report.entityKey}`), link: `${EXPLORER}/entity/${url(report.entityKey)}` })
    lines.push({ cls: 'body', text: truncate(`Swarm ref ${report.swarmRef}`) })
    lines.push({ cls: 'body', text: truncate('Encrypted to the incident’s agent roster; this receipt contains nothing sensitive.') })
  }

  const height = TOP_MARGIN + lines.length * LINE_HEIGHT + BOTTOM_MARGIN

  const body = lines.map((line, i) => {
    const y = TOP_MARGIN + i * LINE_HEIGHT
    const textEl = `<text x="${LEFT_MARGIN}" y="${y}" class="${line.cls}">${esc(line.text)}</text>`
    return line.link ? `<a href="${esc(line.link)}">${textEl}</a>` : textEl
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${WIDTH} ${height}" width="100%">
<style>text{font-family:ui-monospace,Consolas,monospace;fill:#222}.title{font-size:20px;font-weight:700}.head{font-size:13px}.body{font-size:12px}a text{fill:#0645ad}</style>
<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#ffffff" stroke="#cccccc"/>
${body}
</svg>
`
}
