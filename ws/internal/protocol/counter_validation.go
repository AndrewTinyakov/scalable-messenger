package protocol

import (
	"errors"

	"messenger/ws/internal/roomname"
)

func validateEventCounters(e Event) error {
	for _, value := range []string{e.Seq, e.MemberSeq, e.UserSeq} {
		if value != "" && !validCounter(value) {
			return errors.New("invalid event counter")
		}
	}
	seq, member, user := e.Seq != "", e.MemberSeq != "", e.UserSeq != ""
	if member && !roomname.IsUser(e.Room) {
		return errors.New("member sequence outside the user room")
	}
	var valid bool
	switch e.Type {
	case EventHistoryChanged:
		valid = !(seq && member) && !user
	case EventMessageChanged, EventMembershipChanged, EventChatDeleted:
		valid = seq && !member && !user
	case EventPinsChanged:
		valid = seq != member && !user
	case EventChatPreferences:
		valid = !seq && member != user
	case EventReadsChanged:
		valid = !seq && !user
	case EventChatCreated:
		valid = user && !seq && !member
	case EventMemberRemoved:
		valid = !member && seq != user && seq == roomname.IsGroup(e.Room)
	default:
		valid = !seq && !member && !user
	}
	if !valid {
		return errors.New("unexpected event counters")
	}
	return nil
}

func validCounter(value string) bool { return validSequence(value) && value != "0" }
