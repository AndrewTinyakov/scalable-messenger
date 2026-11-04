package protocol

type ErrorCode string

const (
	ErrorInvalidFrame          ErrorCode = "invalid_frame"
	ErrorDependencyUnavailable ErrorCode = "dependency_unavailable"
	ErrorUnauthorized          ErrorCode = "unauthorized"
	ErrorRateLimited           ErrorCode = "rate_limited"
	ErrorRoomLimit             ErrorCode = "room_limit"
	ErrorPublishFailed         ErrorCode = "publish_failed"
	ErrorPublishUnknown        ErrorCode = "publish_unknown"
)
