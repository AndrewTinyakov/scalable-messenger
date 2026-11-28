import { sourceLines } from './lexical.mjs'

const parserDirective = /^#\s*(syntax|escape)\s*=\s*(\S+)\s*$/i
const heredocStatement = /^(?:onbuild\s+)?(?:add|copy|run)\s+(?:--\S+\s+)*/i
const shellWord = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g

function heredocs(instruction) {
  const head = instruction.match(heredocStatement)
  if (!head || !instruction.includes('<<')) return []
  const args = instruction.slice(head[0].length)
  if (/^\[\s*"/.test(args) && /\]\s*$/.test(args)) return []
  return Array.from(args.matchAll(shellWord)).flatMap(([word]) => {
    const marker = word.match(/^\d*<<(-?)([^<].*)$/)
    if (!marker) return []
    const [, stripTabs, name] = marker
    return [{
      stripTabs,
      name: name.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (_, single, double, escaped) =>
        single ?? (double ? double.replace(/\\([\\$"`])/g, '$1') : escaped ?? '')),
    }]
  })
}

export function dockerfileComments(source) {
  const comments = []
  const seen = new Set()
  let inHeader = true
  let escape = '\\'
  let instruction = ''
  let pending = []
  for (const { text, start } of sourceLines(source)) {
    if (pending.length) {
      const { stripTabs, name } = pending[0]
      if ((stripTabs ? text.replace(/^\t+/, '') : text) === name) pending.shift()
      continue
    }

    const line = text.trimStart()
    const directive = inHeader ? line.match(parserDirective) : null
    const name = directive?.[1].toLowerCase()
    const value = directive?.[2]
    if (directive && !seen.has(name) && (name === 'syntax' || value === '\\' || value === '`')) {
      seen.add(name)
      if (name === 'escape') escape = value
      continue
    }

    inHeader = false
    if (line.startsWith('#')) {
      comments.push({ start: start + text.length - line.length })
    } else if (line) {
      const part = (instruction ? text : line).trimEnd()
      if (part.endsWith(escape) && part.at(-2) !== escape) {
        instruction += part.slice(0, -1)
      } else {
        pending = heredocs(instruction + part)
        instruction = ''
      }
    }
  }
  return comments
}
