import type { ReactNode } from 'react'

type InlineToken = { type: 'text' | 'strong' | 'em' | 'code' | 'link'; text: string; href?: string }

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function tokenizeInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ type: 'text', text: source.slice(cursor, index) })
    if (value.startsWith('`')) tokens.push({ type: 'code', text: value.slice(1, -1) })
    else if (value.startsWith('**') || value.startsWith('__')) tokens.push({ type: 'strong', text: value.slice(2, -2) })
    else if (value.startsWith('*') || value.startsWith('_')) tokens.push({ type: 'em', text: value.slice(1, -1) })
    else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const href = linkMatch ? safeHref(linkMatch[2].trim()) : undefined
      tokens.push(href && linkMatch ? { type: 'link', text: linkMatch[1], href } : { type: 'text', text: value })
    }
    cursor = index + value.length
  }
  if (cursor < source.length) tokens.push({ type: 'text', text: source.slice(cursor) })
  return tokens
}

function renderInline(source: string): ReactNode[] {
  return tokenizeInline(source).map((token, index) => {
    switch (token.type) {
      case 'strong': return <strong key={index}>{token.text}</strong>
      case 'em': return <em key={index}>{token.text}</em>
      case 'code': return <code key={index}>{token.text}</code>
      case 'link': return <a key={index} href={token.href} target="_blank" rel="noreferrer">{token.text}</a>
      default: return <span key={index}>{token.text}</span>
    }
  })
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|') && line.trim().endsWith('|')
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function isTableDivider(line: string): boolean {
  return isTableRow(line) && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
}

function isBlockStarter(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? ''
  const startsHeading = /^#{1,6}\s/.test(line)
  const startsFence = line.startsWith('```')
  const startsQuote = line.startsWith('>')
  const startsList = /^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)
  const isRule = /^-{3,}$/.test(line) || /^_{3,}$/.test(line) || /^\*\s*\*\s*\*\s*$/.test(line)
  return !line || startsHeading || startsFence || startsQuote || startsList || isRule || (isTableRow(line) && isTableDivider(lines[index + 1] ?? ''))
}

export default function ChatMarkdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) { index++; continue }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      index++
      const code: string[] = []
      while (index < lines.length && !lines[index].trim().startsWith('```')) code.push(lines[index++])
      if (index < lines.length) index++
      blocks.push(<pre key={`code-${index}`}><code data-language={language || undefined}>{code.join('\n')}</code></pre>)
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = renderInline(heading[2])
      const Heading = `h${level}` as keyof JSX.IntrinsicElements
      blocks.push(<Heading key={`heading-${index}`}>{text}</Heading>)
      index++
      continue
    }

    if (/^(---+|___+|\*\s*\*\s*\*\s*)$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />)
      index++
      continue
    }

    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? '')) {
      const headers = tableCells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableRow(lines[index].trim())) rows.push(tableCells(lines[index++].trim()))
      blocks.push(<div className="chat-md-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '')}</td>)}</tr>)}</tbody></table></div>)
      continue
    }

    if (line.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) quote.push(lines[index++].trim().replace(/^>\s?/, ''))
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((part, quoteIndex) => <p key={quoteIndex}>{renderInline(part)}</p>)}</blockquote>)
      continue
    }

    const listMatch = /^([-*+] |\d+[.)] )(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /^\d/.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const item = /^([-*+] |\d+[.)] )(.*)$/.exec(lines[index].trim())
        if (!item || ordered !== /^\d/.test(item[1])) break
        items.push(item[2]); index++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</List>)
      continue
    }

    const paragraph: string[] = [line]
    index++
    while (index < lines.length && !isBlockStarter(lines, index)) paragraph.push(lines[index++].trim())
    blocks.push(<p key={`paragraph-${index}`}>{paragraph.map((part, partIndex) => <span key={partIndex}>{partIndex > 0 && <br />}{renderInline(part)}</span>)}</p>)
  }
  return <div className="chat-markdown">{blocks}</div>
}
