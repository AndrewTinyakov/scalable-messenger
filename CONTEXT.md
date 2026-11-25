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
- **Chat sequence** numbers every shared event in one chat: saved messages, edits, deletions for everyone, shared clears, shared pins and membership changes. It is monotonic. Message sequences are chat sequences, so history has gaps where other events took numbers or messages were deleted. A device that sees a number more than one above its last one has missed an event. SQL recovery uses it; Redis replay uses the separate room, epoch, and Stream ID cursor.
- **History coverage** is an authoritative snapshot's examined sequence interval. A device can apply its returned rows and certified absences without treating those absences as human reads.
- **Read through** is an account's declaration that the messages up to a chat sequence have been read. It is shared across devices and does not prove that each message crossed a viewport.
- **First read time** is the server acceptance time when an account first advanced through a message. Timestamp details are available for seven days after that message was created.
- **Active connection** is a connection whose client is currently visible and receiving input. A hidden, unfocused or inactive client is idle.
- **Online** means at least one of a user's connections is active, on any device.
- **Last seen** is the most recent time a user was online. Viewers see either the exact time or a coarse bucket, depending on presence visibility.
- **Presence visibility** is the level at which one account may observe another's presence: full, coarse or none. It is decided per viewer and subject, independently of any particular chat.
- **Presence watch** is a connection's bounded set of user IDs whose presence transitions it receives.
- **Group online count** is the number of a small group's members, visible to the viewer, who are online. Large groups show only their member count.
- **Message version** orders changes to one message while its original chat sequence stays the same.
- **Mutation sequence** is the chat sequence of a chat's latest shared edit, deletion or clear. Changes are retained above the mutation floor.
- **Member sequence** numbers one account's private changes in one chat: personal deletion and clear, hiding the chat, personal pins, mute, the unread mark and its own read-through. Other members never see it.
- **Visibility sequence** is the member sequence of an account's latest personal deletion, clear or hide in one chat. History pages are fenced by it, not by every private change.
- **Account sequence** numbers an account's changes that belong to no single chat: being added to or removed from a chat and chat pin order.
- **Chat state** is one authorized snapshot of a chat's sequences, cutoffs and read positions. Devices compare it with what they hold and fetch only what moved.
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
- **Sidebar watch** is a bounded selection of chat rows whose group activity is observed separately from the selected conversation. Presence is observed through the presence watch.
- **Sidebar activity hint** is a bodyless indication that a watched group has accepted a message. It requests an authoritative summary refresh and proves neither application nor human reading.

- **Pinned chat** is an account's ordered sidebar shortcut, at most ten per account. Pinned chats lead the first directory page; activity keysets cover only unpinned chats. Hiding a chat for yourself unpins it.
- **Mute** silences an account's alerts for one chat until a time or forever. An expired mute reads as unmuted without cleanup.
- **Unread mark** is an account's reminder to return to a chat. It is separate from read progress and clears when the account opens the chat.
- **Pinned message** is a message shown at the top of a chat for everyone or, in direct chats only, for one participant. Each scope keeps at most 200 pins. Pins follow the viewer's history visibility and disappear when the message row is removed.
- **Forward** saves a new message whose body is copied from a source message visible to the sender at processing time, crediting the source's original author. Forwarded messages cannot be edited.
- **Personal chat event** is a bodyless hint in the account's user room that carries a member sequence. It covers pin, mute and unread-mark changes. Devices refetch the chat summary.

State the actual guarantee instead of calling a message "delivered". Request IDs identify retries, message IDs identify saved messages, and event IDs identify publications.
