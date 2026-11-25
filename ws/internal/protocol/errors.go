package protocol

type ErrorCode string

const (
	ErrorInvalidFrame          ErrorCode = "INVALID_FRAME"
	ErrorDependencyUnavailable ErrorCode = "DEPENDENCY_UNAVAILABLE"
	ErrorUnauthorized          ErrorCode = "UNAUTHORIZED"
	ErrorRateLimited           ErrorCode = "RATE_LIMITED"
	ErrorRoomLimit             ErrorCode = "ROOM_LIMIT"
	ErrorPublishFailed         ErrorCode = "PUBLISH_FAILED"
	ErrorPublishUnknown        ErrorCode = "PUBLISH_UNKNOWN"
)
