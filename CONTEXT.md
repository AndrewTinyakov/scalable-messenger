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
- **Chat sequence** orders accepted messages within one chat. It is monotonic and can have intentional gaps after deletion. SQL recovery uses it; Redis replay uses the separate room, epoch, and Stream ID cursor.
- **History coverage** is an authoritative snapshot's examined sequence interval. A device can apply its returned rows and certified absences without treating those absences as human reads.
- **Read through** is an account's declaration that the messages up to a chat sequence have been read. It is shared across devices and does not prove that each message crossed a viewport.
- **First read time** is the server acceptance time when an account first advanced through a message. Timestamp details are available for seven days after that message was created.
- **Online** means at least one established connection was observed for a user. An unavailable or stale observation is unknown.
- **Message version** orders changes to one message while its original chat sequence stays the same.
- **Mutation revision** orders shared edits and deletions within a chat, independently of new-message sequences.
- **Visibility revision** orders one account's history visibility changes in one chat. It is separate from the shared mutation revision.
- **Personal deletion** hides content for one account across its devices, using a prefix cutoff and merged sequence exclusions. Membership remains an authorization fact.
- **Clear history** removes the accepted prefix at the operation's server snapshot and keeps the chat active. Later accepted messages survive.
- **Hidden chat** has a personal history cutoff and a hidden sidebar entry. A later saved message above the hide cutoff makes it visible again.
- **Purge** permanently removes globally deleted message rows in bounded transactions after immediate visibility denial. Acceptance and physical completion are separate states.
- **Reply** refers to another message in the same chat. Its quote shows a viewer-authorized current preview, or an unavailable target when that message is missing or hidden.
- **Chat deletion** with everyone scope closes the chat identity for all members and schedules permanent history purge. A later direct conversation uses a new chat. Self scope hides the existing chat for one account.
- **Recovery hint** contains durable identifiers and cursors without message or quote text. Redis retains hints; full live message frames are ephemeral.

State the actual guarantee instead of calling a message "delivered". Request IDs identify retries, message IDs identify saved messages, and event IDs identify publications.
