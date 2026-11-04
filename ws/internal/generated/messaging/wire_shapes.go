package messaging

type WireShape struct {
	Required []string
	Optional []string
}

var FrameShapes = map[FrameType]WireShape{
	"send":             {Required: []string{"type", "version", "requestId", "body"}, Optional: []string{"chatId", "recipientId", "replyToMessageId"}},
	"subscribe":        {Required: []string{"type", "version", "chatId", "kind"}, Optional: []string{"epoch", "streamId", "lastAppliedSequence"}},
	"subscribe_many":   {Required: []string{"type", "version", "subscriptions"}, Optional: []string{}},
	"unsubscribe":      {Required: []string{"type", "version", "chatId"}, Optional: []string{}},
	"applied":          {Required: []string{"type", "version", "chatId", "sequence"}, Optional: []string{"epoch", "streamId"}},
	"dismissed":        {Required: []string{"type", "version", "chatId", "sequence"}, Optional: []string{}},
	"received_message": {Required: []string{"type", "version", "chatId", "sequence"}, Optional: []string{}},
	"watch_presence":   {Required: []string{"type", "version", "chatId", "userIds"}, Optional: []string{}},
	"unwatch_presence": {Required: []string{"type", "version"}, Optional: []string{}},
	"watch_sidebar":    {Required: []string{"type", "version", "chatIds"}, Optional: []string{}},
}

var RoomShapes = map[EventType]WireShape{
	"chat_created":       {Required: []string{"type", "version", "eventId", "room", "chatId"}, Optional: []string{"requestId"}},
	"member_removed":     {Required: []string{"type", "version", "eventId", "room", "chatId", "memberId"}, Optional: []string{}},
	"session_revoked":    {Required: []string{"type", "version", "eventId", "room", "sessionId"}, Optional: []string{}},
	"message_saved":      {Required: []string{"type", "version", "eventId", "room", "chatId", "requestId", "messageId", "sequence", "senderId", "body", "createdAt"}, Optional: []string{"messageVersion", "replyToMessageId", "replySenderId", "replyBody", "replyDeleted", "replyVersion"}},
	"send_rejected":      {Required: []string{"type", "version", "eventId", "room", "requestId", "reason"}, Optional: []string{"chatId", "recipientId"}},
	"membership_changed": {Required: []string{"type", "version", "eventId", "room", "chatId"}, Optional: []string{}},
	"message_changed":    {Required: []string{"type", "version", "eventId", "room", "chatId", "messageId", "sequence", "senderId", "body", "createdAt", "messageVersion", "mutationRevision"}, Optional: []string{"editedAt", "deletedAt", "replyToMessageId", "replySenderId", "replyBody", "replyDeleted", "replyVersion"}},
	"chat_deleted":       {Required: []string{"type", "version", "eventId", "room", "chatId"}, Optional: []string{}},
	"reads_changed":      {Required: []string{"type", "version", "eventId", "room", "chatId"}, Optional: []string{}},
	"history_changed":    {Required: []string{"type", "version", "eventId", "room", "chatId", "sequence", "mutationRevision", "visibilityRevision"}, Optional: []string{}},
}
