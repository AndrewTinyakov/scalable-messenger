# Messenger domain language

The Messenger example has direct and group conversations, several devices per user, and a saved history that clients can recover after a gap.

## Language

**Conversation**:
An ordered history shared by a defined set of members. A conversation can be direct or a group.

**Room**:
A live recipient set. A user room contains that user's connected devices; a group room contains connected devices of that group's members. A room is not the durable conversation history.

**Send request**:
One user's intent to send a message, identified by a request ID that stays the same across retries.

**Queued**:
The system has accepted responsibility to process a send request. Validation and message saving may still fail.

**Saved**:
The message is committed to durable conversation history. This says nothing about which devices have seen it.

**Rejected**:
The system has finished processing a send request without saving a message and has recorded the reason.

**Applied**:
A device has incorporated a message into its local view and acknowledged that fact. This is a per-device fact.

**Conversation sequence**:
The position assigned to a saved message in one conversation's accepted order. Clients use it to request missing saved messages.

Avoid the unqualified word **delivered** in a guarantee. State whether the claim means queued, saved, sent to a WebSocket node, written to a socket, or applied by a particular device.
