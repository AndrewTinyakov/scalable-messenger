export interface ChatViewport {
  chatId: string
  atLatest: boolean
}

interface LiveChatState {
  selectedId: string | undefined
  viewport: ChatViewport | null
  hasNewer: boolean
  loadedMessages: number
  pageActive: boolean
}

export function liveChatId({
  selectedId,
  viewport,
  hasNewer,
  loadedMessages,
  pageActive,
}: LiveChatState): string | null {
  const confirmed = viewport?.chatId === selectedId && viewport?.atLatest
  return selectedId && confirmed && !hasNewer && loadedMessages > 0 && pageActive
    ? selectedId
    : null
}
