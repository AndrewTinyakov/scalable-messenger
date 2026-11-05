package protocol

import (
	"errors"
	"time"
	"unicode/utf8"
)

func validateFeatureFrame(f Frame) error {
	if f.Type != FrameSend && (f.ReplyToMessageID != "" || f.ForwardFromChatID != "" || f.ForwardFromMsgID != "") {
		return errors.New("unexpected send metadata")
	}
	if (f.ForwardFromChatID == "") != (f.ForwardFromMsgID == "") {
		return errors.New("incomplete forward source")
	}
	if f.ForwardFromChatID != "" && (!ValidULID(f.ForwardFromChatID) || !ValidULID(f.ForwardFromMsgID) || f.ChatID == "" || f.RecipientID != "" || f.ReplyToMessageID != "") {
		return errors.New("invalid forward source")
	}
	if f.Type != FrameWatchPresence && f.UserIDs != nil {
		return errors.New("unexpected presence targets")
	}
	if f.ReplyToMessageID != "" && (!ValidULID(f.ReplyToMessageID) || f.ChatID == "" || f.RecipientID != "") {
		return errors.New("invalid reply target")
	}
	if f.Type != FrameWatchPresence && f.Type != FrameUnwatchPresence {
		return nil
	}
	if f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" || f.Subscriptions != nil {
		return errors.New("invalid presence watch")
	}
	if f.Type == FrameUnwatchPresence {
		if f.ChatID != "" {
			return errors.New("invalid presence unwatch")
		}
		return nil
	}
	if !ValidULID(f.ChatID) || len(f.UserIDs) < 1 || len(f.UserIDs) > 100 {
		return errors.New("invalid presence targets")
	}
	seen := make(map[string]bool, len(f.UserIDs))
	for _, id := range f.UserIDs {
		if !ValidULID(id) || seen[id] {
			return errors.New("invalid presence target")
		}
		seen[id] = true
	}
	return nil
}

func validateFeatureEvent(e Event) error {
	if e.ObservedAt != "" || e.ValidForMS != 0 || e.Statuses != nil {
		return errors.New("unexpected presence metadata")
	}
	if e.ForwardedFromUserID != "" && (e.Type != EventMessageSaved || !ValidULID(e.ForwardedFromUserID)) {
		return errors.New("invalid forwarded author")
	}
	if e.Type != EventHistoryChanged && e.VisibilityRevision != "" {
		return errors.New("unexpected visibility revision")
	}
	if e.Type == EventHistoryChanged {
		if e.MessageVersion != "" || e.EditedAt != "" || e.DeletedAt != "" || e.ReplyToMessageID != "" || e.ReplySenderID != "" || e.ReplyBody != "" || e.ReplyDeleted != nil || e.ReplyVersion != "" {
			return errors.New("unexpected history change metadata")
		}
		return nil
	}
	if e.Type != EventMessageSaved && e.Type != EventMessageChanged {
		if e.MessageVersion != "" || e.MutationRevision != "" || e.EditedAt != "" || e.DeletedAt != "" || e.ReplyToMessageID != "" || e.ReplySenderID != "" || e.ReplyBody != "" || e.ReplyDeleted != nil || e.ReplyVersion != "" {
			return errors.New("unexpected message metadata")
		}
		return nil
	}
	if e.MessageVersion != "" && (!validSequence(e.MessageVersion) || e.MessageVersion == "0") {
		return errors.New("invalid message version")
	}
	if e.Type == EventMessageSaved && (e.MutationRevision != "" || e.EditedAt != "" || e.DeletedAt != "") {
		return errors.New("unexpected mutation metadata")
	}
	if e.ReplyToMessageID == "" {
		if e.ReplySenderID != "" || e.ReplyBody != "" || e.ReplyDeleted != nil || e.ReplyVersion != "" {
			return errors.New("incomplete reply")
		}
		return nil
	}
	if e.Type == EventMessageSaved && ValidULID(e.ReplyToMessageID) && e.ReplySenderID == "" && e.ReplyBody == "" && e.ReplyDeleted == nil && e.ReplyVersion == "" {
		return nil
	}
	if !ValidULID(e.ReplyToMessageID) || !ValidULID(e.ReplySenderID) || e.ReplyDeleted == nil || !validSequence(e.ReplyVersion) || e.ReplyVersion == "0" || utf8.RuneCountInString(e.ReplyBody) > 160 || (*e.ReplyDeleted && e.ReplyBody != "") || (!*e.ReplyDeleted && e.ReplyBody == "") {
		return errors.New("invalid reply preview")
	}
	return nil
}

func validateChangedMessage(e Event) error {
	if !ValidULID(e.ChatID) || !ValidULID(e.MessageID) || !ValidULID(e.SenderID) || e.RequestID != "" || e.RecipientID != "" || e.Reason != "" || !validSequence(e.Sequence) || e.Sequence == "0" || !validSequence(e.MessageVersion) || e.MessageVersion == "0" || !validSequence(e.MutationRevision) || e.MutationRevision == "0" || utf8.RuneCountInString(e.Body) > 4000 {
		return errors.New("invalid changed message")
	}
	if (e.DeletedAt != "") != (e.Body == "") {
		return errors.New("invalid tombstone")
	}
	for _, value := range []string{e.CreatedAt, e.EditedAt, e.DeletedAt} {
		if value == "" && value != e.CreatedAt {
			continue
		}
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return errors.New("invalid mutation timestamp")
		}
	}
	return nil
}
