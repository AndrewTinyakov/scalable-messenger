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
	if f.ReplyToMessageID != "" && (!ValidULID(f.ReplyToMessageID) || f.ChatID == "" || f.RecipientID != "") {
		return errors.New("invalid reply target")
	}
	switch f.Type {
	case FrameWatchPresence:
		return validatePresenceTargets(f.Add, f.Remove)
	case FrameWatchOnline:
		if f.ChatID != "" && !ValidULID(f.ChatID) {
			return errors.New("invalid online count chat")
		}
	}
	return nil
}

func validatePresenceTargets(lists ...[]string) error {
	for _, ids := range lists {
		if len(ids) > 500 {
			return errors.New("too many presence targets")
		}
		seen := make(map[string]bool, len(ids))
		for _, id := range ids {
			if !ValidULID(id) || seen[id] {
				return errors.New("invalid presence target")
			}
			seen[id] = true
		}
	}
	return nil
}

func validateFeatureEvent(e Event) error {
	if e.Statuses != nil || e.Unavailable != nil || e.Online != 0 || e.Members != 0 || e.IdleAfterHiddenMS != 0 || e.IdleAfterInputMS != 0 || e.ReleaseAfterHiddenMS != 0 {
		return errors.New("unexpected presence metadata")
	}
	if e.ForwardedFromUserID != "" && (e.Type != EventMessageSaved || !ValidULID(e.ForwardedFromUserID)) {
		return errors.New("invalid forwarded author")
	}
	if e.Type == EventHistoryChanged {
		if e.MessageVersion != "" || e.EditedAt != "" || e.DeletedAt != "" || e.ReplyToMessageID != "" || e.ReplySenderID != "" || e.ReplyBody != "" || e.ReplyDeleted != nil || e.ReplyVersion != "" {
			return errors.New("unexpected history change metadata")
		}
		return nil
	}
	if e.Type != EventMessageSaved && e.Type != EventMessageChanged {
		if e.MessageVersion != "" || e.EditedAt != "" || e.DeletedAt != "" || e.ReplyToMessageID != "" || e.ReplySenderID != "" || e.ReplyBody != "" || e.ReplyDeleted != nil || e.ReplyVersion != "" {
			return errors.New("unexpected message metadata")
		}
		return nil
	}
	if e.MessageVersion != "" && (!validSequence(e.MessageVersion) || e.MessageVersion == "0") {
		return errors.New("invalid message version")
	}
	if e.Type == EventMessageSaved && (e.EditedAt != "" || e.DeletedAt != "") {
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
	if !ValidULID(e.ChatID) || !ValidULID(e.MessageID) || !ValidULID(e.SenderID) || e.RequestID != "" || e.RecipientID != "" || e.Reason != "" || !validSequence(e.Sequence) || e.Sequence == "0" || !validSequence(e.MessageVersion) || e.MessageVersion == "0" || !validCounter(e.Seq) || utf8.RuneCountInString(e.Body) > 4000 {
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
