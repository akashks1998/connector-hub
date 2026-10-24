// Runs an example and saves its output as a terminal-style SVG for the README.
// Usage: node scripts/screenshot.mjs <example> [title]
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [name, title = `pnpm --filter connector-hub-examples ${name}`] = process.argv.slice(2)
if (!name) throw new Error('usage: node scripts/screenshot.mjs <example> [title]')
const output = execFileSync('node', [`src/${name}.ts`], { cwd: new URL('../examples/', import.meta.url), encoding: 'utf8' })

const maxCols = 100
const lines = [`$ ${title}`, ...output.trimEnd().split('\n')].map((l) => (l.length > maxCols ? `${l.slice(0, maxCols - 1)}…` : l))
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const charW = 9
const lineH = 20
const pad = 20
const top = 44
const width = Math.ceil(Math.max(...lines.map((l) => l.length), 60) * charW + pad * 2)
const height = top + lines.length * lineH + pad

const text = lines
  .map((l, i) => `<text x="${pad}" y="${top + 14 + i * lineH}"${i === 0 ? ' class="cmd"' : ''} xml:space="preserve">${esc(l)}</text>`)
  .join('\n  ')

writeFileSync(
  new URL(`../docs/images/${name}.svg`, import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)} output">
  <style>
    text { font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #d7dae0; }
    .cmd { fill: #7ee787; }
  </style>
  <rect width="${width}" height="${height}" rx="10" fill="#161b22"/>
  <circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
  ${text}
</svg>
`,
)
console.log(`docs/images/${name}.svg`)
