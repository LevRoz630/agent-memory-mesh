// Public, human-readable "incident receipt": a self-contained HTML page published to Swarm as a
// /bzz manifest (src/swarm.mjs's uploadPublicFile) so judges can open it in a browser without
// downloading anything. Contains nothing sensitive: the referenced Swarm report stays encrypted
// to the incident roster, and this page only ever shows its reference, not its contents.

const EXPLORER = 'https://tiramisu.explorer.arkiv.network'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const url = (s) => esc(encodeURIComponent(String(s ?? '')))

function resolvedBy(state) {
  const id = Object.keys(state.agents).find((agentId) => state.agents[agentId].status === 'done')
  return id ?? null
}

export function renderReceipt(state) {
  const resolver = resolvedBy(state)
  const outcome = resolver
    ? `Resolved by <b>${esc(resolver)}</b>`
    : `Phase: ${esc(state.phase)}`

  const timelineItems = state.timeline.map((e) =>
    `<li><time>${esc(new Date(e.at).toISOString())}</time> <b>${esc(e.agentId)}</b> ${esc(e.text)}</li>`
  ).join('')

  const report = state.report
  const reportLine = report
    ? `<p>Encrypted report on Swarm: <span class="mono">${esc(report.swarmRef)}</span>. ` +
      `It is encrypted to the incident's agent roster; this receipt contains nothing sensitive.</p>` +
      `<p>Arkiv entity: <a href="${EXPLORER}/entity/${url(report.entityKey)}">${esc(report.entityKey)}</a></p>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hydra incident receipt</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.4;color:#222;background:#fff}
h1{font-size:1.3rem;margin:0 0 0.2rem}
.tag{color:#666;font-size:0.9rem;margin-bottom:1rem}
ul{list-style:none;padding:0;margin:0 0 1rem}
li{padding:0.25rem 0;border-bottom:1px dashed #ccc;font-size:0.85rem}
time{color:#666;margin-right:0.5rem;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,monospace;font-size:0.85em;word-break:break-all}
a{color:#0645ad}
</style>
</head>
<body>
<h1>Hydra incident receipt</h1>
<div class="tag">Incident ${esc(state.tag)}</div>
<p>${outcome}</p>
<h2>Timeline</h2>
<ul>${timelineItems}</ul>
${reportLine}
</body>
</html>
`
}
