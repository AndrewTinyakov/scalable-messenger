class SqlTokenError extends Error {
  constructor(pos, message) {
    super(message)
    this.pos = pos
  }
}

function identifierStart(char) {
  return char === '_' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
    char?.charCodeAt(0) >= 128
}

function identifierPart(char) {
  return identifierStart(char) || (char >= '0' && char <= '9')
}

function dollarDelimiter(source, start) {
  let end = start + 1
  if (source[end] === '$') return '$$'
  if (!identifierStart(source[end])) return undefined
  end++
  while (identifierPart(source[end])) end++
  if (source[end] === '$') return source.slice(start, end + 1)
}

function quotedEnd(source, start, backslashEscapes) {
  const quote = source[start]
  for (let index = start + 1; index < source.length; index++) {
    if (backslashEscapes && source[index] === '\\') index++
    else if (source[index] === quote) {
      if (source[index + 1] !== quote) return index + 1
      index++
    }
  }
  throw new SqlTokenError(start, 'unterminated SQL quoted token')
}

function blockEnd(source, start) {
  let depth = 1
  let index = start + 2
  while (index < source.length) {
    if (source.startsWith('/*', index)) {
      depth++
      index += 2
    } else if (source.startsWith('*/', index)) {
      index += 2
      if (--depth === 0) return index
    } else {
      index++
    }
  }
  throw new SqlTokenError(start, 'unterminated SQL block comment')
}

function stringContinuation(source, previous, start) {
  if (!previous || !quotedStringTypes.has(previous.type)) return false
  const gap = source.slice(previous.end, start)
  return /[\r\n]/.test(gap) && /^(?:\s|--[^\r\n]*)*$/.test(gap)
}

const quotedStringTypes = new Set(['string', 'escape-string', 'unicode-string'])

function* tokenize(source) {
  let start = 0
  let previous
  while (start < source.length) {
    const char = source[start]
    const next = source[start + 1]
    let end = start + 1
    let type = char
    let delimiter
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\uFEFF') {
      start++
      continue
    }
    if (char === '-' && next === '-') {
      type = 'comment'
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++
    } else if (char === '/' && next === '*') {
      type = 'comment'
      end = blockEnd(source, start)
    } else if ((char === 'e' || char === 'E') && next === "'") {
      type = 'escape-string'
      end = quotedEnd(source, start + 1, true)
    } else if ((char === 'u' || char === 'U') && next === '&' && source[start + 2] === "'") {
      type = 'unicode-string'
      end = quotedEnd(source, start + 2, false)
    } else if (char === "'" || char === '"') {
      type = char === '"' ? 'quoted-identifier' :
        stringContinuation(source, previous, start) ? previous.type : 'string'
      end = quotedEnd(source, start, type === 'escape-string')
    } else if (char === '$' && (delimiter = dollarDelimiter(source, start))) {
      type = 'dollar-string'
      const closing = source.indexOf(delimiter, start + delimiter.length)
      if (closing === -1) throw new SqlTokenError(start, 'unterminated SQL dollar quote')
      end = closing + delimiter.length
    } else if (identifierStart(char)) {
      type = 'word'
      while (identifierPart(source[end]) || source[end] === '$') end++
    }
    const token = { type, start, end, delimiter }
    if (type !== 'comment') previous = token
    yield token
    start = end
  }
}

function word(source, token) {
  if (token?.type !== 'word') return undefined
  return source.slice(token.start, token.end).toLowerCase()
}

function languageName(source, statement, index) {
  const token = statement[index]
  if (token?.type === 'quoted-identifier') return source.slice(token.start + 1, token.end - 1)
  if (quotedStringTypes.has(token?.type)) return routineSource(source, routineLiteral(source, statement, index)).content
  return word(source, token)
}

function routineBody(source, statement) {
  const first = word(source, statement[0])
  const routine = word(source, statement[word(source, statement[1]) === 'or' ? 3 : 1])
  const anonymous = first === 'do'
  if (!anonymous && !(first === 'create' && (routine === 'function' || routine === 'procedure'))) {
    return undefined
  }

  const optionsStart = anonymous ? 1 : statement.findIndex(({ type }) => type === '(')
  if (optionsStart === -1) return undefined

  let depth = 0
  let body
  let language = anonymous ? 'plpgsql' : undefined
  for (let index = optionsStart; index < statement.length; index++) {
    const token = statement[index]
    if (token.type === '(') depth++
    if (token.type === ')') depth--
    if (depth !== 0) continue

    const keyword = word(source, token)
    const next = statement[index + 1]
    const declaredLanguage = keyword === 'language' ? languageName(source, statement, index + 1) : undefined
    if (declaredLanguage) {
      language = declaredLanguage
      index++
    } else if (keyword === 'as' && !anonymous && isBodyString(next)) {
      body = routineLiteral(source, statement, index + 1)
    } else if (anonymous && !body && isBodyString(token)) {
      body = routineLiteral(source, statement, index)
    }
  }
  if (language === 'sql' || language === 'plpgsql') return body
}

function isBodyString(token) {
  return token?.type === 'dollar-string' || quotedStringTypes.has(token?.type)
}

function routineLiteral(source, statement, index) {
  const first = statement[index]
  const parts = [first]
  while (++index < statement.length) {
    const next = statement[index]
    if (source[next.start] !== "'" || !stringContinuation(source, parts.at(-1), next.start)) break
    parts.push(next)
  }
  let unicodeEscape = '\\'
  const escape = statement[index + 1]
  if (first.type === 'unicode-string' && word(source, statement[index]) === 'uescape' &&
      escape?.type === 'string' && escape.end - escape.start === 3) {
    unicodeEscape = source[escape.start + 1]
  }
  return { parts, unicodeEscape }
}

const escapeCharacters = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

function decodeCodePoint(digits, offset) {
  const point = Number.parseInt(digits, 16)
  if (point > 0x10ffff) throw new SqlTokenError(offset, 'invalid SQL Unicode escape')
  return String.fromCodePoint(point)
}

function decodeEscape(sequence, offset) {
  const escape = sequence[1]
  const digits = sequence.slice(2)
  if (digits && (escape === 'u' || escape === 'U')) return decodeCodePoint(digits, offset)
  if (digits && escape === 'x') return String.fromCharCode(Number.parseInt(digits, 16))
  if (/[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(sequence.slice(1), 8) & 255)
  return escapeCharacters[escape] ?? escape
}

function routineSource(source, { parts, unicodeEscape }) {
  const first = parts[0]
  if (first.delimiter) {
    const start = first.start + first.delimiter.length
    return { content: source.slice(start, first.end - first.delimiter.length), original: (index) => start + index }
  }

  let content = ''
  const offsets = []
  const append = (value, original) => {
    content += value
    for (let index = 0; index < value.length; index++) offsets.push(original)
  }
  const unicodeMarker = RegExp.escape(unicodeEscape)
  const unicodePattern = new RegExp("''|" + unicodeMarker + '(?:' + unicodeMarker +
    '|\\+[0-9a-fA-F]{6}|[0-9a-fA-F]{4})', 'g')
  for (const part of parts) {
    const start = source.indexOf("'", part.start) + 1
    const end = part.end - 1
    let pattern = /''/g
    if (part.type === 'escape-string') {
      pattern = /''|\\(?:x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g
    } else if (part.type === 'unicode-string') {
      pattern = unicodePattern
    }
    let index = start
    for (const { 0: sequence, index: relative } of source.slice(start, end).matchAll(pattern)) {
      const original = start + relative
      while (index < original) append(source[index], index++)
      if (sequence === "''") append("'", original)
      else if (part.type === 'escape-string') append(decodeEscape(sequence, original), original)
      else if (sequence === unicodeEscape.repeat(2)) append(unicodeEscape, original)
      else append(decodeCodePoint(sequence.slice(sequence[1] === '+' ? 2 : 1), original), original)
      index += sequence.length
    }
    while (index < end) append(source[index], index++)
  }
  offsets.push(parts.at(-1).end - 1)
  return { content, original: (index) => offsets[index] }
}

export function postgresComments(source) {
  const comments = []
  let statement = []
  function scanRoutineBody() {
    const body = routineBody(source, statement)
    if (!body) return
    const { content, original } = routineSource(source, body)
    try {
      for (const token of postgresComments(content)) {
        comments.push({ start: original(token.start), end: original(token.end) })
      }
    } catch (error) {
      if (error instanceof SqlTokenError) error.pos = original(error.pos)
      throw error
    }
  }

  for (const token of tokenize(source)) {
    if (token.type === 'comment') comments.push(token)
    else if (token.type === ';') {
      scanRoutineBody()
      statement = []
    } else statement.push(token)
  }
  scanRoutineBody()
  return comments.sort((left, right) => left.start - right.start)
}
