package roomname

import (
	"hash/fnv"
	"strconv"
	"strings"
)

const (
	PresencePrefix  = "presence:"
	PresenceBuckets = 4096
)

func PresenceBucket(bucket int) string { return PresencePrefix + strconv.Itoa(bucket) }

func IsPresence(room string) bool { return strings.HasPrefix(room, PresencePrefix) }

// PresenceBucketOf is part of the Redis key layout. Changing it re-keys all
// presence state.
func PresenceBucketOf(userID string) int {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(userID))
	return int(hash.Sum32() % PresenceBuckets)
}
