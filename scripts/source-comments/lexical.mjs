const newline = /[\r\n]/

export function* sourceLines(source) {
  for (const match of source.matchAll(/([^\r\n]*)(?:\r\n|[\r\n]|$)/g)) {
    yield { text: match[1], start: match.index }
  }
}

function afterLine(source, start) {
  const length = source.slice(start).search(newline)
  return length < 0 ? source.length : start + length
}

function afterDelimiter(source, start, delimiter) {
  const end = source.indexOf(delimiter, start)
  return end < 0 ? source.length : end + delimiter.length
}

function afterQuote(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === quote) return index + 1
    index += source[index] === '\\' ? 2 : 1
  }
  return source.length
}

export function slashComments(source, blockComments = true) {
  const comments = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"') {
      index = afterQuote(source, index)
    } else if (source.startsWith('//', index)) {
      comments.push({ start: index })
      index = afterLine(source, index + 2)
    } else if (blockComments && source.startsWith('/*', index)) {
      comments.push({ start: index })
      index = afterDelimiter(source, index + 2, '*/')
    } else {
      index++
    }
  }
  return comments
}

export function nginxComments(source) {
  const comments = []
  let inArgument = false
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (!inArgument && char === '#') {
      comments.push({ start: index })
      index = source.indexOf('\n', index)
      if (index === -1) break
    } else if (!inArgument && (char === "'" || char === '"')) {
      index = afterQuote(source, index)
      if (source[index] === ')') index++
    } else if (char === '\\' || source.startsWith('${', index)) {
      inArgument = true
      index += 2
    } else {
      inArgument = !/[ \t\r\n;{]/.test(char) && (inArgument || char !== '}')
      index++
    }
  }
  return comments
}

function longBracket(source, start) {
  if (source[start] !== '[') return undefined
  let index = start + 1
  while (source[index] === '=') index++
  if (source[index] === '[') {
    return afterDelimiter(source, index + 1, ']' + source.slice(start + 1, index) + ']')
  }
}

export function luaComments(source) {
  const comments = []
  let index = source.startsWith('#!') ? afterLine(source, 0) : 0
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"') {
      index = afterQuote(source, index)
    } else if (source.startsWith('--', index)) {
      comments.push({ start: index })
      index = longBracket(source, index + 2) ?? afterLine(source, index + 2)
    } else {
      index = longBracket(source, index) ?? index + 1
    }
  }
  return comments
}

export function erlangTermComments(source) {
  const comments = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"') {
      index = afterQuote(source, index)
    } else if (char === '%') {
      comments.push({ start: index })
      index = afterLine(source, index + 1)
    } else {
      index += char === '$' ? (source[index + 1] === '\\' ? 3 : 2) : 1
    }
  }
  return comments
}

export function propertiesComments(source) {
  const comments = []
  let continued = false
  for (const { text, start } of sourceLines(source)) {
    const content = text.replace(/^[ \t\f]+/, '')
    if (!continued && /^[#!]/.test(content)) {
      comments.push({ start: start + text.length - content.length })
    } else {
      continued = (text.match(/\\+$/)?.[0].length ?? 0) % 2 === 1
    }
  }
  return comments
}

export function lineComments(source, marker) {
  return Array.from(sourceLines(source)).flatMap(({ text, start }) => {
    const match = text.match(marker)
    return match ? [{ start: start + match.index + match[0].length - 1 }] : []
  })
}

export function goModComments(source) {
  const comments = []
  let requireBlock = false
  for (const { text, start } of sourceLines(source)) {
    const [comment] = slashComments(text, false)
    const statement = text.slice(0, comment?.start ?? text.length).trim()
    const dependency = requireBlock ? statement : statement.match(/^require\s+(.+)$/)?.[1]
    if (comment && !(
      /^\/\/ indirect[ \t]*$/.test(text.slice(comment.start)) &&
      /^(?:"(?:\\.|[^"\\])*"|\S+)\s+v\d+\.\d+\.\d+\S*$/.test(dependency ?? '')
    )) {
      comments.push({ start: start + comment.start })
    }
    if (/^require\s*\($/.test(statement)) requireBlock = true
    if (statement === ')') requireBlock = false
  }
  return comments
}
