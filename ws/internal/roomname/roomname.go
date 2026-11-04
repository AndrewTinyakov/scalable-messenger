package roomname

import "strings"

const (
	UserPrefix  = "user:"
	GroupPrefix = "group:"
)

func User(userID string) string  { return UserPrefix + userID }
func Group(chatID string) string { return GroupPrefix + chatID }
func IsUser(room string) bool    { return strings.HasPrefix(room, UserPrefix) }
func IsGroup(room string) bool   { return strings.HasPrefix(room, GroupPrefix) }
