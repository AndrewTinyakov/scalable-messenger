# Messenger domain language

The Messenger example has direct and group chats, several devices per user, and a saved history that clients can recover after a gap.

## Language

**Chat**:
An ordered history shared by a defined set of members. A chat can be direct or a group.
_Avoid_: Conversation

**Direct draft**:
A local view of another user before the first message. Selecting a user does not create a SQL chat. The first accepted direct send resolves the pair and creates the chat in the same transaction as its first saved message.

**Chat created**:
A committed chat becoming visible to its members. The SQL transaction adds an outbox event for every member's user room. Group creation emits it immediately; direct creation emits it with the first saved message.

**Room**:
A live recipient set. A user room contains that user's connected devices; a group room contains connected devices of that group's members. A room is not the durable chat history.

**Send request**:
One user's intent to send a message, identified by a request ID that stays the same across retries.

**Queued**:
The system has accepted responsibility to process a send request. Validation and message saving may still fail.

**Saved**:
The message is committed to durable chat history. This says nothing about which devices have seen it.

**Rejected**:
The system has finished processing a send request without saving a message and has recorded the reason.

**Applied**:
A device has incorporated a message into its local view and acknowledged that fact. This is a per-device fact.

**Received message**:
A device has handled one live WebSocket message notification. This releases that socket's pending frame without claiming the message was applied or changing the SQL history recovery baseline.

**Dismissed**:
A device has chosen to start at a newer chat sequence, either on its first opening of a chat or by explicitly jumping over an existing recovery gap. It resolves the socket's pending acknowledgement window and advances catch-up, but does not claim those messages were applied. The skipped history remains available on scroll back.

**Recovery baseline**:
The highest chat sequence the device has either applied or explicitly dismissed for future catch-up. This position can differ from the last applied message after a dismissal.

**Chat sequence**:
The position assigned to a saved message in one chat's accepted order. Clients use it to request missing saved messages.

Avoid the unqualified word **delivered** in a guarantee. State whether the claim means queued, saved, sent to a WebSocket node, written to a socket, or applied by a particular device.
