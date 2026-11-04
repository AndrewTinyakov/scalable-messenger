package protocol

import (
	"errors"
	"regexp"

	"messenger/ws/internal/generated/messaging"
	"messenger/ws/internal/messagecodec"
)

var streamIDPattern = regexp.MustCompile(`^[0-9]+-[0-9]+$`)

func validateFrameFields(frame Frame, fields messagecodec.Fields) error {
	shape, known := messaging.FrameShapes[frame.Type]
	if !known || !fields.Match(shape.Required, shape.Optional) {
		return errors.New("invalid frame fields")
	}
	if fields.Has("replyToMessageId") && !ValidULID(frame.ReplyToMessageID) {
		return errors.New("invalid reply target")
	}
	for _, id := range []struct{ name, value string }{{"chatId", frame.ChatID}, {"recipientId", frame.RecipientID}} {
		if fields.Has(id.name) && !ValidULID(id.value) {
			return errors.New("invalid frame identifier")
		}
	}
	if fields.Has("lastAppliedSequence") && !validSequence(frame.LastAppliedSequence) {
		return errors.New("invalid applied baseline")
	}
	if fields.Has("epoch") && frame.Epoch == "" {
		return errors.New("invalid room epoch")
	}
	if fields.Has("streamId") && !streamIDPattern.MatchString(frame.StreamID) {
		return errors.New("invalid room stream cursor")
	}
	return nil
}

func validateEventFields(event Event, fields messagecodec.Fields) error {
	shape, known := messaging.RoomShapes[event.Type]
	if !known || !fields.Match(shape.Required, shape.Optional) {
		return errors.New("invalid event fields")
	}
	for _, id := range []struct{ name, value string }{{"chatId", event.ChatID}, {"recipientId", event.RecipientID}, {"requestId", event.RequestID}} {
		if fields.Has(id.name) && !ValidULID(id.value) {
			return errors.New("invalid event identifier")
		}
	}
	if fields.Has("messageVersion") && (!validSequence(event.MessageVersion) || event.MessageVersion == "0") {
		return errors.New("invalid message version")
	}
	if (fields.Has("editedAt") && event.EditedAt == "") || (fields.Has("deletedAt") && event.DeletedAt == "") {
		return errors.New("invalid mutation timestamp")
	}
	replyFields := 0
	for _, name := range []string{"replyToMessageId", "replySenderId", "replyBody", "replyDeleted", "replyVersion"} {
		if fields.Has(name) {
			replyFields++
		}
	}
	if replyFields != 0 && replyFields != 5 {
		return errors.New("incomplete reply metadata")
	}
	if replyFields == 5 && !ValidULID(event.ReplyToMessageID) {
		return errors.New("invalid reply target")
	}
	return nil
}
