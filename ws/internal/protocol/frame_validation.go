package protocol

import (
	"errors"
	"strings"
)

func validateSendFrame(f Frame) error {
	if (f.ChatID == "") == (f.RecipientID == "") ||
		(f.ChatID != "" && !ValidULID(f.ChatID)) ||
		(f.RecipientID != "" && !ValidULID(f.RecipientID)) ||
		!ValidULID(f.RequestID) || strings.TrimSpace(f.Body) == "" || len([]rune(f.Body)) > 4000 || f.Kind != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
		return errors.New("invalid send")
	}
	return nil
}

func validateWatchSidebarFrame(f Frame) error {
	if f.ChatIDs == nil || len(f.ChatIDs) > 100 {
		return errors.New("invalid sidebar targets")
	}
	seen := make(map[string]bool, len(f.ChatIDs))
	for _, id := range f.ChatIDs {
		if !ValidULID(id) || seen[id] {
			return errors.New("invalid sidebar target")
		}
		seen[id] = true
	}
	return nil
}

func validateSubscribeFrame(f Frame) error {
	if f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" {
		return errors.New("invalid subscribe")
	}
	if !validSubscription(Subscription{f.ChatID, f.Kind, f.Epoch, f.StreamID, f.LastAppliedSequence}) {
		return errors.New("invalid subscribe")
	}
	return nil
}

func validateSubscribeManyFrame(f Frame) error {
	if f.ChatID != "" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" || len(f.Subscriptions) < 1 || len(f.Subscriptions) > 10 {
		return errors.New("invalid subscribe batch")
	}
	seen := make(map[string]struct{}, len(f.Subscriptions))
	for _, subscription := range f.Subscriptions {
		if !validSubscription(subscription) {
			return errors.New("invalid subscribe batch entry")
		}
		if _, exists := seen[subscription.ChatID]; exists {
			return errors.New("duplicate chat in subscribe batch")
		}
		seen[subscription.ChatID] = struct{}{}
	}
	return nil
}

func validateUnsubscribeFrame(f Frame) error {
	if !ValidULID(f.ChatID) || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
		return errors.New("invalid unsubscribe")
	}
	return nil
}

func validateAppliedFrame(f Frame) error {
	if !ValidULID(f.ChatID) || !validSequence(f.Sequence) {
		return errors.New("invalid applied position")
	}
	if f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.LastAppliedSequence != "" {
		return errors.New("invalid applied frame")
	}
	if (f.Epoch == "") != (f.StreamID == "") {
		return errors.New("incomplete Redis cursor")
	}
	return nil
}

func validateDismissedFrame(f Frame) error {
	if !ValidULID(f.ChatID) || !validSequence(f.Sequence) || f.Sequence == "0" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
		return errors.New("invalid dismissed frame")
	}
	return nil
}

func validateReceivedMessageFrame(f Frame) error {
	if !ValidULID(f.ChatID) || !validSequence(f.Sequence) || f.Sequence == "0" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
		return errors.New("invalid received message frame")
	}
	return nil
}
