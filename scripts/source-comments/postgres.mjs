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

function* tokenize(source) {
  let start = 0
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
    } else if (char === "'" || char === '"') {
      type = char === "'" ? 'string' : 'quoted-identifier'
      end = quotedEnd(source, start, false)
    } else if (char === '$' && (delimiter = dollarDelimiter(source, start))) {
      type = 'dollar-string'
      const closing = source.indexOf(delimiter, start + delimiter.length)
      if (closing === -1) throw new SqlTokenError(start, 'unterminated SQL dollar quote')
      end = closing + delimiter.length
    } else if (identifierStart(char)) {
      type = 'word'
      while (identifierPart(source[end]) || source[end] === '$') end++
    }
    yield { type, start, end, delimiter }
    start = end
  }
}

function word(source, token) {
  if (token?.type !== 'word') return undefined
  return source.slice(token.start, token.end).toLowerCase()
}

function languageName(source, token) {
  if (token?.type === 'quoted-identifier' || token?.type === 'string') {
    return source.slice(token.start + 1, token.end - 1)
  }
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
    const declaredLanguage = keyword === 'language' ? languageName(source, next) : undefined
    if (declaredLanguage) {
      language = declaredLanguage
      index++
    } else if (keyword === 'as' && !anonymous && next?.delimiter) {
      body = next
    } else if (anonymous && token.delimiter) {
      body = token
    }
  }
  if (body?.type === 'dollar-string' && (language === 'sql' || language === 'plpgsql')) return body
}

export function postgresComments(source) {
  const comments = []
  let statement = []
  function scanRoutineBody() {
    const body = routineBody(source, statement)
    if (!body) return
    const start = body.start + body.delimiter.length
    const content = source.slice(start, body.end - body.delimiter.length)
    try {
      for (const token of postgresComments(content)) {
        comments.push({ start: start + token.start, end: start + token.end })
      }
    } catch (error) {
      if (error instanceof SqlTokenError) error.pos += start
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
