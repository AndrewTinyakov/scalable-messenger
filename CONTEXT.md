# Messenger terms

- **User** is an account identified by a user ID and username, authenticated with a password. The messenger has no separate profile.
- **Session** is a user's authenticated access from one device until expiry or revocation. One user can have several sessions.

- **Chat** is an ordered durable history shared by members. Chats are direct or group.
- **Direct draft** is a local recipient selection. The first accepted send creates the direct chat and first message together.
- **Chat created** makes a committed chat visible through each member's user room.
- **Room** is a live recipient set, separate from chat history. User rooms contain a user's devices; group rooms contain group members' devices.
- **Send request** is a user's intent identified by a request ID retained across retries.
- **Queued** means RabbitMQ confirmed responsibility for processing the request. It can still be rejected.
- **Saved** means the message committed to SQL history.
- **Rejected** is a recorded terminal result without a saved message.
- **Applied** means one device incorporated a message and acknowledged it.
- **Received message** releases a pending live frame without advancing SQL recovery.
- **Dismissed** advances recovery to an explicitly chosen sequence without claiming the skipped messages were applied.
- **Recovery baseline** is the highest sequence applied or dismissed by a device.
- **Chat sequence** orders saved messages within one chat. SQL recovery uses it; Redis replay uses the separate room, epoch, and Stream ID cursor.
- **Read through** is an account's declaration that the messages up to a chat sequence have been read. It is shared across devices and does not prove that each message crossed a viewport.
- **First read time** is the server acceptance time when an account first advanced through a message. Timestamp details are available for seven days after that message was created.
- **Online** means at least one established connection was observed for a user. An unavailable or stale observation is unknown.
- **Message version** orders changes to one message while its original chat sequence stays the same.
- **Mutation revision** orders edits and deletions within a chat, independently of new-message sequences.
- **Tombstone** is a deleted message whose identity and place in the conversation remain, with its text removed.
- **Reply** is a message referring to another message in the same chat. Its quote shows the referenced message's current short preview or deleted state.
- **Chat deletion** removes a direct or group conversation for all members. A later direct conversation between the same users is a new chat.

State the actual guarantee instead of calling a message "delivered". Request IDs identify retries, message IDs identify saved messages, and event IDs identify publications.
