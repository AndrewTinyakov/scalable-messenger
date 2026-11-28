import { TokenType, tokenize } from '@csstools/css-tokenizer'
import { parse } from 'parse5'
import { SaxesParser } from 'saxes'

export function cssComments(source) {
  return tokenize({ css: source }).flatMap(([type, , start]) =>
    type === TokenType.Comment ? [{ start }] : [],
  )
}

export function htmlComments(source) {
  const comments = []
  function collect(node) {
    const location = node.sourceCodeLocation
    if (node.nodeName === '#comment') {
      comments.push({ start: location.startOffset })
    } else if (node.nodeName === 'style' && location?.startTag) {
      const start = location.startTag.endOffset
      const end = location.endTag?.startOffset ?? location.endOffset
      for (const comment of cssComments(source.slice(start, end))) {
        comments.push({ start: start + comment.start })
      }
    }
    node.childNodes?.forEach(collect)
    if (node.content) collect(node.content)
  }
  collect(parse(source, { sourceCodeLocationInfo: true }))
  return comments
}

export function xmlComments(source) {
  const comments = []
  const parser = new SaxesParser({ position: true })
  parser.on('comment', () => {
    comments.push({ start: source.lastIndexOf('<!--', parser.position - 1) })
  })
  parser.write(source).close()
  return comments
}
