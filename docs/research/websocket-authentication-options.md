# WebSocket authentication options

Research date: 2026-10-19. Official sources were opened directly. The observations below describe the checkout before migration. The selected minimal path is now implemented with mTLS and session-ID RPCs; see [local setup](../../README.md). The alternatives and lease-policy changes remain design proposals.

## Behavior before migration

REST uses a random opaque cookie backed by a SQL session, with a 30-day expiry. Logout deletes that session and enqueues a session-revoked event in the same transaction. The separate WS ticket is an HS256 JWT containing user, device, session, issuer, audience, and expiry. Its lifetime is the earlier of one hour and session expiry. See [AuthenticationService](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/service/AuthenticationService.kt), [SessionCookie](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/web/SessionCookie.kt), and [WsTicketService](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/service/WsTicketService.kt).

Go verifies the ticket locally, receives it through `Sec-WebSocket-Protocol`, attaches the user-room feed, then calls `ValidateSession` before starting normal socket processing. Group subscriptions use gRPC membership checks, including a check after feed attachment. Kotlin verifies the forwarded JWT and checks its session/user/device tuple against SQL. Go closes sockets at ticket expiry and on matching revocation events. See [handshake](../../ws/internal/socket/http.go), [subscriptions](../../ws/internal/socket/subscription_batch.go), [connection](../../ws/internal/socket/connection.go), and [authorization service](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/grpc/ChatAuthorizationGrpcService.kt).

The [Go gRPC client](../../ws/internal/grpcauth/client.go) explicitly uses insecure transport credentials. The [Kotlin server setup](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/grpc/GrpcServerLifecycle.kt) configures neither TLS nor caller authentication. There is no separate WS-service API key in these paths.

[Compose](../../compose.yaml) publishes the API proxy's HTTP port, but does not host-publish gRPC port 9090. Its API, WS, and other containers share the default network; there is no dedicated internal gRPC network. [Nginx](../../deploy/nginx/api.conf) forwards plaintext gRPC to the APIs. The CI override publishes database/broker test ports, with no additional gRPC mapping. This repository contains no cloud VPC or firewall configuration that proves production isolation. There is also no current account-ban feature in the account schema or authorization handlers.

## What the sources establish

Browser `WebSocket` exposes URL and subprotocol arguments, without an arbitrary-header option. Its handshake includes eligible cookies. Cookie scope and browser policy still apply. [WHATWG WebSockets](https://websockets.spec.whatwg.org/#the-websocket-interface)

JWT forwarding is a valid pattern when the recipient is intended to accept that token and validates it. OWASP also permits explicitly trusted internal identity assertions, while warning that a trusted service can misrepresent them. Authenticating the caller and authorizing its right to assert user identity are separate requirements. [OWASP identity propagation](https://cheatsheetseries.owasp.org/cheatsheets/Identity_Propagation_Patterns_Cheat_Sheet.html#propagation-patterns)

JWT verification needs an allowed algorithm, trusted issuer, correct audience, and the applicable token profile. A valid signature protects claims; it does not prove current membership or session validity. Online introspection can report expiry and revocation, with caching trading freshness for availability and load. This project's custom gRPC checks resemble that pattern but are not RFC 7662 OAuth introspection. [RFC 8725 §§3.1–3.12](https://www.rfc-editor.org/rfc/rfc8725.html#section-3), [RFC 7662 §§2, 4](https://www.rfc-editor.org/rfc/rfc7662.html#section-2)

Private network placement limits exposure but does not establish service identity. NIST rejects implicit trust based solely on network location. gRPC supports TLS server authentication, client certificates for mutual authentication, and separate call credentials. [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final), [gRPC authentication](https://grpc.io/docs/guides/auth/)

## Three pragmatic options

These comparisons are project-specific recommendations based on those facts. All three need WSS and an exact browser Origin allowlist. Cookie-authenticated endpoints also retain CSRF protections.

### 1. Same-site cookie with gRPC validation

Let Go receive the existing HttpOnly session cookie and ask Kotlin to resolve it into an active session. Retain only the returned identity and expiry for subsequent authorization. This removes the separate browser WS credential and duplicated JWT verification, but Go now receives the reusable REST credential.

Keep `Secure`, `HttpOnly`, and explicit `SameSite`; require an exact trusted browser Origin. Same-site does not mean same-origin. The current cookie path follows the configured `/api` servlet path, so `/ws` needs a deliberate routing or cookie-scope change. Avoid broadening the cookie domain to accommodate another host. These scope constraints follow [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#cookies) and [RFC 6265 §5.1.4](https://www.rfc-editor.org/rfc/rfc6265.html#section-5.1.4). This is attractive for a permanently shared host, with the cost of exposing the REST cookie to Go.

### 2. Opaque short-lived WS ticket with gRPC redemption

Issue a random WS-only bearer ticket through authenticated REST. Store its hash, session binding, purpose, and a short redemption deadline, initially 60 seconds. Go redeems it through authenticated gRPC; Kotlin atomically consumes it and verifies the active session. Return the identity tuple and session deadline. Every reconnect obtains a fresh ticket. Atomic consumption adds replay resistance that ordinary validation alone does not provide.

This keeps the REST cookie out of Go and removes Go's JWT signing secret. It adds ticket storage, cleanup, an online admission dependency, and retry semantics for an uncertain redemption outcome. Prefer an initial authentication frame over WSS, with no protected data before success, a short timeout, and bounded unauthenticated sockets. OWASP recommends this over URL query tokens because URLs leak through logs. The current subprotocol transport also needs credential redaction. [OWASP WebSocket authentication](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html#session-management)

### 3. Local JWT admission with authenticated identity-bearing gRPC

Keep browser admission unchanged. Go derives `sessionId`, `userId`, and `deviceId` from the verified ticket and connection state, then sends them through authenticated gRPC. Kotlin accepts assertions only from the authorized WS service and checks the complete tuple against current SQL session state before checking membership.

Passing only `userId` loses the distinction between a revoked session and the user's other active sessions. `deviceId` does not replace a session identifier. Never let later browser frames choose the asserted identity. Preserve the existing ticket-expiry socket deadline. Add an explicit ticket-deadline guard before group authorization calls when removing downstream JWT checks. This guard is new: Go currently closes via an asynchronous timer, while Kotlin's JWT validation independently rejects an expired ticket during these calls. Do not assume the timer supplies an equivalent synchronous check.

This reduces repeated JWT handling but explicitly trusts Go to assert users. A compromised authorized Go service can lie. Sharing HS256 already lets Go mint tickets; changing request fields does not create independent cryptographic user proof. Retaining forwarding is also defensible. Document Kotlin's issuer-side validation role for the current `messenger-ws` audience rather than treating this ticket as a general API token. Token exchange is available if future services need distinct audiences or delegation, but adds unnecessary issuance machinery here. [RFC 8693 §1.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-1.1)

## Revocation, subscriptions, and races

The following are proposed project guarantees, not guarantees supplied by a token format.

Separate ticket redemption expiry, session expiry, and socket authorization lifetime. An opaque ticket may expire after successful redemption while the socket continues under the active session. For option 3, retain today's shorter ticket-bound socket lifetime unless deliberately changing policy. JWT `exp` governs acceptance; applications must define ongoing connection behavior. Expiry or revocation can occur after any validation, whether local or remote. Duplicate validation does not make forwarding invalid. [RFC 7519 §4.1.4](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.4)

Authenticate each new group subscription under the existing connection using its bound session tuple and current SQL membership. Preserve checks after feed attachment and local grant invalidation. An authenticated connection grants no blanket group access. Close revoked sessions across WS nodes, revoke affected subscriptions on member removal, and discard locally queued frames whose grants ended. OWASP calls for continuing session validation and action-level authorization. [OWASP WebSocket authorization](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html#message-level-authorization)

Preserve the existing transaction and outbox ordering for logout and [member removal](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/ChatMembershipService.kt). Attach revocation observation before the final SQL check. An event received during admission must defeat a concurrent positive response. Async outbox delivery still leaves a window after SQL commit, and bytes already written cannot be recalled. Define revocation as prompt event handling plus a bounded revalidation interval, rather than zero delivery after commit. A stricter guarantee needs coordination between membership changes and delivery, beyond a gRPC lookup.

Keep SQL membership enforcement in the send transaction. For logout, distinguish refusing new WS commands from cancelling already queued work. The current [send command](../../ws/internal/socket/commands.go) carries `senderId` without session identity. Rejecting that work specifically because its session was revoked would require session context and an authoritative check at processing time. Choose and document that ordering separately from socket closure.

## Service trust, abuse, and outages

For this deployment, start with server-authenticated TLS and a dedicated, rotatable WS-service API key in gRPC metadata, authorized only for these RPCs. Prefer mTLS when certificate provisioning and rotation are available. API keys are bearer credentials; mTLS proves possession of a client private key. Both require explicit caller permissions. Authorize the verified WS service identity, rather than accepting every certificate from a trusted CA. Network restrictions remain useful alongside either. The existing nginx hop needs an explicit trust design: use TLS passthrough to an API that authenticates the WS certificate, or authenticate and authorize at a protected proxy with an authenticated upstream. An API listener reachable directly must enforce equivalent checks, so the proxy cannot be bypassed. [OWASP gRPC authentication](https://cheatsheetseries.owasp.org/cheatsheets/gRPC_Security_Cheat_Sheet.html#authentication-and-authorization), [OWASP microservices](https://cheatsheetseries.owasp.org/cheatsheets/Microservices_Security_Cheat_Sheet.html#service-to-service-authentication)

Bound pre-authentication attempts by IP and global capacity, then connections and operations by session/user. Keep message, subscription, byte-queue, and concurrent authorization limits. Cookie and opaque admission need early limits before an SQL lookup; local JWT rejection alone is insufficient abuse control. [OWASP WebSocket resource limits](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html#denial-of-service-protection)

Reject admission and new subscriptions when required validation fails or times out. Use explicit [gRPC deadlines](https://grpc.io/docs/guides/deadlines/). For active sockets, define a maximum authorization lease capped by session expiry and renew it against authoritative state. Select its duration from the acceptable revocation delay and measured SQL/RPC load. Today's group grant lasts ten minutes; session validation happens at connection admission, with logout events and ticket expiry closing sockets afterward. Adding periodic session validation would be a separate behavior and capacity change. Failed renewal must suspend protected delivery or close the connection at lease end; grants must not extend indefinitely during SQL, gRPC, or revocation-feed outages.

## Private deployment network

A private cloud network in one region is practical. For example, AWS supports private VPC subnets without a direct route to an internet gateway and security-group rules restricting a destination port to the WS workload's source security group. Keep gRPC off public listeners and restrict both proxy and direct API paths. These are deployment options, not controls already present in this repository. Private routing complements service authentication. [AWS subnets](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html), [AWS security-group referencing](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html#security-group-referencing)

## Recommended direction

Choose option 3 as the minimal change: authenticate gRPC first, preserve SQL checks and expiry, then replace JWT parameters with connection-derived session context. Retain revocation ordering and define the required revocation bound before separately changing authorization leases. Choose option 2 longer term if removing shared HS256 keys and keeping REST cookies out of Go justifies ticket storage. Neither choice requires replacing the existing REST session system.
