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

- **Last message summary** is the latest viewer-visible message among a chat's newest 256 stored candidates, with its identity, sequence, sender ID and current username, creation time, and a preview of at most 160 Unicode characters. A null summary means no candidate in that window is visible; older visible history can still exist. Summary reads do not advance human reads or device recovery.
- **Window unread count** counts visible messages by other authors above the account's read-through in the newest 256 stored candidates. A saturated window makes the count a lower bound, including when that bound is zero; it does not measure a sequence difference.
- **Chat activity** is the time of the most recent accepted send in a chat. Empty chats use the viewer's membership join time when ordered in the directory.
- **Sidebar watch** is a bounded selection of visible chat rows whose direct peers' presence and group activity are observed separately from the selected conversation.
- **Sidebar activity hint** is a bodyless indication that a watched group has accepted a message. It requests an authoritative summary refresh and proves neither application nor human reading.

- **Pinned chat** is an account's ordered sidebar shortcut, at most ten per account. Pinned chats lead the first directory page; activity keysets cover only unpinned chats. Hiding a chat for yourself unpins it.
- **Mute** silences an account's alerts for one chat until a time or forever. An expired mute reads as unmuted without cleanup.
- **Unread mark** is an account's reminder to return to a chat. It is separate from read progress and clears when the account opens the chat.
- **Pinned message** is a message shown at the top of a chat for everyone or, in direct chats only, for one participant. Each scope keeps at most 200 pins. Pins follow the viewer's history visibility and disappear when the message row is removed.
- **Forward** saves a new message whose body is copied from a source message visible to the sender at processing time, crediting the source's original author. Forwarded messages cannot be edited.
- **Personal chat event** is a bodyless hint in the account's user room. It covers pin, mute and unread-mark changes. Devices refetch the chat summary.

State the actual guarantee instead of calling a message "delivered". Request IDs identify retries, message IDs identify saved messages, and event IDs identify publications.
