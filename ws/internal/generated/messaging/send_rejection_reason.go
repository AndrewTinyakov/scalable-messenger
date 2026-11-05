package messaging

import (
	"encoding/json"
	"fmt"
)

type SendRejectionReason uint

const (
	SendRejectionReasonNotAMember SendRejectionReason = iota
	SendRejectionReasonChatNotFound
	SendRejectionReasonRecipientNotFound
	SendRejectionReasonInvalidRecipient
	SendRejectionReasonEmptyBody
	SendRejectionReasonBodyTooLong
	SendRejectionReasonRequestIdConflict
	SendRejectionReasonProcessingFailed
	SendRejectionReasonInvalidReplyTarget
	SendRejectionReasonInvalidForwardSource
)

// Value returns the value of the enum.
func (op SendRejectionReason) Value() any {
	if op >= SendRejectionReason(len(SendRejectionReasonValues)) {
		return nil
	}
	return SendRejectionReasonValues[op]
}

var SendRejectionReasonValues = []any{"NOT_A_MEMBER", "CHAT_NOT_FOUND", "RECIPIENT_NOT_FOUND", "INVALID_RECIPIENT", "EMPTY_BODY", "BODY_TOO_LONG", "REQUEST_ID_CONFLICT", "PROCESSING_FAILED", "INVALID_REPLY_TARGET", "INVALID_FORWARD_SOURCE"}
var ValuesToSendRejectionReason = map[any]SendRejectionReason{
	SendRejectionReasonValues[SendRejectionReasonNotAMember]:           SendRejectionReasonNotAMember,
	SendRejectionReasonValues[SendRejectionReasonChatNotFound]:         SendRejectionReasonChatNotFound,
	SendRejectionReasonValues[SendRejectionReasonRecipientNotFound]:    SendRejectionReasonRecipientNotFound,
	SendRejectionReasonValues[SendRejectionReasonInvalidRecipient]:     SendRejectionReasonInvalidRecipient,
	SendRejectionReasonValues[SendRejectionReasonEmptyBody]:            SendRejectionReasonEmptyBody,
	SendRejectionReasonValues[SendRejectionReasonBodyTooLong]:          SendRejectionReasonBodyTooLong,
	SendRejectionReasonValues[SendRejectionReasonRequestIdConflict]:    SendRejectionReasonRequestIdConflict,
	SendRejectionReasonValues[SendRejectionReasonProcessingFailed]:     SendRejectionReasonProcessingFailed,
	SendRejectionReasonValues[SendRejectionReasonInvalidReplyTarget]:   SendRejectionReasonInvalidReplyTarget,
	SendRejectionReasonValues[SendRejectionReasonInvalidForwardSource]: SendRejectionReasonInvalidForwardSource,
}

func (op *SendRejectionReason) UnmarshalJSON(raw []byte) error {
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	if value == nil {
		return fmt.Errorf("SendRejectionReason must be a string")
	}
	decoded, ok := ValuesToSendRejectionReason[*value]
	if !ok {
		return fmt.Errorf("invalid SendRejectionReason: %q", *value)
	}
	*op = decoded
	return nil
}

func (op SendRejectionReason) MarshalJSON() ([]byte, error) {
	return json.Marshal(op.Value())
}
