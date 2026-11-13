package socket

type lifecycleState uint8

const (
	lifecycleActive lifecycleState = iota
	lifecycleClosed
)

type serverState uint8

const (
	serverAccepting serverState = iota
	serverDraining
	serverClosing
)

type commandState uint8

const (
	commandIdle commandState = iota
	commandQueued
	commandRunning
)
