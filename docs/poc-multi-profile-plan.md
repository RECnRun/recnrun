# Plan: more than two profiles

Branch `poc/multi-profile-mesh`, stacked on `poc/dashboard-only-pairing` (PR #16). It carries out "More than two profiles" in `docs/poc-dashboard-pairing-plan.md`, the user's requirement of 2026-10-27: pair the default profile and profiles A, B, and C at once, each one controlling the others' tabs.

## Goal

Every profile that chose the RECnRun folder links with every other one there, with no click: a mesh of one WebRTC link per pair. Each dashboard lists its own tabs and every peer's, each under the profile's name and link state. Disconnect, Reconnect, and Forget act on one peer and leave the others linked. One recording session runs at a time across all of them.

## Today: one peer everywhere

| Layer      | Where                                                                                       | One peer because                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Offscreen  | `p2p/peer-link.ts`, `offscreen/start.ts`                                                    | One `RTCPeerConnection`; a new offer or answer closes the previous one                             |
| Link API   | `messaging/peer-messages.ts`                                                                | `offer`, `answer`, `accept-answer`, `send`, `close`, and the `frame`/`state` events name no peer   |
| Storage    | `storage/peer-repository.ts`, `messaging/peer-results.ts`                                   | `authorizedPeer`, `peerLink`, `peerTabs`, `pendingOffer`, `remoteRecording`, `folderPairing.acted` |
| Pairing    | `background/pairing.ts`                                                                     | Accepting a code replaces the pinned peer                                                          |
| Folder     | `background/folder-pairing.ts`                                                              | One partner: the pinned peer, or else the profile that waited longest                              |
| Channel    | `background/peer-channel.ts`, `background/peers.ts`                                         | Sends to and accepts from the one peer                                                             |
| Requests   | `background/peer-requests.ts`                                                               | `tabs`, `activate`, `session-*`, `disconnect`, `forget` name no peer; `status` returns one         |
| Dashboard  | `dashboard/PeerProfiles.tsx`, `FolderPairing.tsx`, `peer-blocks.ts`, `views/remote-peer.ts` | One remote tab list, one link line, one remote session                                             |
| End-to-end | `tests/e2e/fixtures/profiles.ts`, `folder.ts`                                               | Fixtures `profileA` and `profileB`; `pair(a, b)`                                                   |

What already fits: the protocol's envelope carries `from` and `to`, signal files name their `to`, the rule "the lower profile id offers" holds per pair, the heartbeat lives in each `PeerLink`, and the executor keeps the controlling profile's id.

## Decisions

The user chose the per-peer pause and no cap on 2026-10-27.

- **A mesh, one link per pair.** With N profiles each holds N − 1 links. No hub: any profile may quit without cutting the others off.
- **Peers keyed by profile id.** `local:authorizedPeers`, `session:peerLinks`, `session:peerTabs`, `session:remoteRecordings`, `session:pendingOffers`, and the folder's `acted` become records keyed by the peer's profile id. Every write goes through the schema at the boundary, as today.
- **A frame belongs to its connection.** The offscreen document reports which peer's connection a frame came on, and the channel accepts it only when its `from` is that peer and that peer's link is verified. Without this, profile C could send frames claiming to be B over C's own verified link.
- **No migration.** A stored `local:authorizedPeer` is dropped. Since `local:folderPairing` stays, the profiles pair again through the folder on the first run, with no click.
- **One session across all profiles.** While a session runs anywhere, no list offers Record, as with two profiles. The PiP window floats this profile's own session, or else the one it controls in whichever peer runs it.
- **Disconnect and Forget per peer.** Disconnect closes the link to that peer and pauses it: the folder does not link with it again until **Reconnect** on that peer. Forget removes it and keeps it paused, so it does not pair again at once while it stays in the folder. **Pair with other profiles**, shown while any peer is paused, clears every pause. The alternative, Forget letting the profile pair again at once, makes Forget undo itself.
- **No cap on N.** Tests cover three profiles. The folder is polled once a second whatever N is, and each link beats once a second.
- **Joining later needs the folder.** Chrome ends the picker's grant with the extension's last top-level page (H2), so a profile already paired sees a newcomer only while it holds the folder: with "Allow on every visit", or after **Allow folder** in its banner. The dashboard already shows that banner while the grant is missing.

## Tasks

Each task is one commit, with `Red:` and `Green:` lines, and `vp run verify` exits 0 before the next one starts. Red runs the new test against the code before the change and sees it fail for the stated reason.

### 1. One link per peer in the offscreen document

`offer`, `answer`, `accept-answer`, `send`, and `close` take `peer` (a profile id); `frame` and `state` events carry it. The offscreen document keeps a `Map` of `PeerLink`s, and a new offer or answer replaces only that peer's link. The background still has one peer and passes its id.

- **Red:** `offscreen-start.test.ts` "keeps one link per peer: a second peer's offer leaves the first linked, and each frame reports its peer". It fails since the second offer closes the first link and events carry no `peer`. `peer-messages.test.ts` refuses `send` without `peer`.
- **Green:** the same tests, and every end-to-end test unchanged (two profiles still pair).

### 2. Storage and channel keyed by peer

The repositories become records. `pairing.ts` adds the accepted profile instead of replacing it. `peer-channel.ts` sends to a named peer and checks a frame against its connection's peer. `linkUp` and `linkDown` change only that peer's link, fail only its waiters, and mark only its mirror. `HELLO` renames only its sender.

- **Red:**
  - `pairing.test.ts` "accepting a second profile keeps the first";
  - `peer-channel.test.ts` "drops a frame whose `from` is not the peer of its connection" and "sends to the named peer only while its link is verified";
  - `peers-link.test.ts` "a link that drops leaves the other peer's link, waiters, and tabs alone".

  Each fails today for one peer or a replaced peer.

- **Green:** those tests, and the existing ones with records.

### 3. The folder pairs with every presence

`decideFolderStep` returns one step per presence that is not linked and not paused. Each pair has its own pending offer, its own `acted`, and its own 30 s retry, and the lower id offers. Steps run one at a time per peer.

- **Red:**
  - `folder-pairing.test.ts` "offers to C while linked to B";
  - "answers B's offer and offers to D in the same sighting" (ids chosen so this profile is in the middle);
  - "the retry for one pair does not hold back another".

  Today the first two return a single step or `wait`, and the retry is global.

- **Green:** those tests and the existing ones, with records.

### 4. Requests and status per peer

`tabs`, `activate`, `session-start`, `session-set`, `session-stop`, `disconnect`, `reconnect`, and `forget` name the peer. `status` returns `peers: [{ peer, link, peerSession }]`, plus `paused`. Disconnect pauses one peer and leaves the folder running for the others. A local session blocks starting one in any peer, and a session running in any peer blocks the rest.

- **Red:** `peer-requests.test.ts`:
  - "disconnect closes one peer's link and keeps waiting for the others";
  - "forget removes one peer and keeps it paused";
  - "session-start refuses while a session runs in another peer";
  - "status lists every peer".
- **Green:** those tests.

### 5. The dashboard per peer

`PeerProfiles` renders one remote `TabList` per peer, headed "Chrome — <name> (<state>)". The Pairing section has one line per peer with its state, **Disconnect** or **Reconnect**, and **Forget <name>**. `peerBlocks` and `remoteRecordings`/`eitherSession` look across all peers.

- **Red:** `peer-profiles.browser.test.tsx`:
  - "lists each peer's tabs under its name";
  - "Disconnect on one peer leaves the other's list live";
  - "a session in one peer blocks Record in the others' lists".

  `session.browser.test.tsx`: "the PiP window shows the session this profile controls in the second peer".

- **Green:** those tests.

### 6. Three profiles end to end

A `profileC` fixture, and a `pairAll(profiles, native)` helper that chooses the folder in each. A new `cross-profile-mesh.spec.ts`:

- three profiles link pairwise, and each dashboard lists the other two profiles' tabs;
- Disconnect between A and B leaves A–C and B–C linked, and Reconnect brings A–B back;
- quitting C shows C as down in A and B within 5 s, while A–B stays connected;
- a session A runs in C blocks Record in B;
- a frame A sends over its own link while claiming B's id gets no answer from C.

The existing two-profile specs stay.

- **Red:** the new spec run in the scratch copy at task 5's parent commit. C stays "Waiting for another profile…", since today A and B pinned each other.
- **Green:** the spec at task 6, and the whole end-to-end suite.
- **Risks:** three Chromium instances per test make runs slower and heavier in Docker. The `xdotool` driver must tell three browsers' pickers apart.

### 7. Docs

`docs/ARCHITECTURE.md` (the POC section: storage keys, the link API, the mesh, the frame-to-connection check), `POC-CROSS-PROFILE-WEBRTC.md` (the mesh, clicks per case with three profiles, "Before production"), `docs/POCS.md`, `.claude/rules/extension.md` if its storage or messaging rules change (then confirm Codex loads it), and this plan's results.

## Manual check for the user

In three profiles of branded Chrome, choose the RECnRun folder in each. Count the clicks until each dashboard lists the other two. Then:

1. Disconnect one pair and Reconnect it.
2. Quit one profile and time how long the other two take to show it down.
3. Record in one profile from another, and see that the third offers no Record.
