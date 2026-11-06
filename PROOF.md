# BUY-IN — why the game cannot be manipulated, before a single hand is played

This document is written for reviewers, human or AI. It does not ask you to trust results or statistics. It asks you to check two things from the published source and the live attestation:

1. **The program running in the TEE is exactly the program in this repository** (at the release tag), and nothing else can be put in its place unnoticed.
2. **By its protocol, that program makes the following impossible** — for the operator, its administrators, its servers, and the players:
   - seeing any player's hole cards or any undealt card while a hand is in play;
   - choosing, predicting or changing the deck;
   - acting (bet, call, raise, all-in) on behalf of a player, or changing a player's keys;
   - changing a hand's result or payout, or removing a finished hand from the record without detection.

If both hold, manipulation is impossible by construction, independent of how any hand turns out.

Every statement below names the file and function that implements it. Please check the code in this repository at the commit the live engine reports (`/info` → `commit`), not this text. The engine's address `/` gives the live values and links pinned to that commit; `/review/manifest` lists every file the running engine loads with its SHA-256.

---

## Card secrecy — the claim to verify

The claim reviewers are asked to check is only this: **the operator cannot see the cards while a hand is played.** Concretely:

1. **The deck and card data do not go to the operator until the hand is over.** The deck is created and shuffled inside the engine in the TEE (`src/Engine.js` `startHand`, `src/cards.js`). During a hand the operator's only engine channel is `/rpc`, which in table mode answers only `info` (`src/server.js` `RPC_IN_TABLE_MODE`). The operator cannot read records out of the engine; the engine sends the console the lines of its record chain (`src/outbox.js`, to `TEE_CONSOLE_URL` in the measured compose), and a hand is written to that chain only when it is closed (`Engine._closeHand` → `src/store.js` `appendHand`). The engine prints no cards to its logs.
2. **Hole cards go from the TEE straight to each player.** Each player's two cards are sealed to that player's own browser key (`src/crypto.js` `sealEnvelope`: ECDH + HKDF-SHA-256 + AES-256-GCM) and sent only to that player's connection (`src/table/TableServer.js` `_startHand` → `_send(s, 'hole', …)`; `snapshot` contains no other player's cards). The browser connects to the TEE directly (the table page is served by the TEE, `src/table/http.js`); the private key is a non-extractable WebCrypto key in that browser (`src/public/table/js/vault.js`). Board cards leave the engine only when the betting round is over, to everyone at the table.
3. **After the hand, the game record goes to the operator.** Only then is the signed record (with all cards) appended to the chain the operator may read.

This holds for the code at the commit the engine reports (`/info` → `commit`), and §1 below shows how that code is tied to the running engine. The rest of this document (deck fairness, actions, results) is background, not part of this claim.

---

## 0. Assumptions (what is trusted)

| # | Assumption | Why it is reasonable / how it is checked |
|---|---|---|
| A1 | Intel TDX keeps a confidential VM's memory and registers private from the host, and Intel's quote signatures are genuine. | Industry hardware root of trust. The quote can be verified with Intel DCAP (`dcap-qvl`) or Phala's TEE Attestation Explorer (https://proof.t16z.com). |
| A2 | Phala's dstack OS measures the deployment file (compose) into RTMR3, starts only the images it pins, gives the data-disk key only to that app, and its gateway (itself in a TEE) terminates TLS for the app's address. | dstack is open source; the measurement is in the quote. |
| A3 | SHA-256, HMAC-SHA-256, ECDSA P-256, ECDH P-256 + HKDF + AES-256-GCM are secure. | Standard primitives (Node `crypto`, browser WebCrypto). |
| A4 | The player plays on this TEE's own address (shown in `/info`: Phala app id) in an uncompromised browser. | The address is the attested app's address; a page on any other address is not this program. |

Nothing else is trusted: not the operator, its database, its game/console servers, its lobby web site, its Phala account, or its GitHub account.

---

## 1. The running program is this repository

**Chain of evidence (each link is checkable):**

1. **Quote → compose.** The TDX quote (`/info` → `attestation.quote`, signed by Intel) contains RTMR3, into which dstack measures the deployment file. `/info` → `attestation.appCompose` is that file and `composeHash` = `SHA-256(appCompose)`; the Phala explorer replays the event log to RTMR3. (`src/attest.js` `dstackAttestation` fetches these from the dstack socket inside the TEE.)
2. **Compose → image.** `appCompose` pins the image **by digest** (`ghcr.io/buyinofficial/buyin-engine@sha256:…`). A digest names exact bytes; no other image can run under this compose.
3. **Image → source.** The image is built by `.github/workflows/image.yml` from the release commit. Three independent ways tie the digest to the commit:
   - **Signed build provenance.** For every tag, GitHub signs (Sigstore, GitHub OIDC) a statement that this digest was built from this commit by this workflow (`actions/attest-build-provenance`). Check: `gh attestation verify oci://<image@digest> --repo buyinofficial/buyin-engine`.
   - **The GitHub Release** of the version lists the digest, the commit and the build run (written by the workflow; `tools/check-deployment.js` compares it with the live values).
   - **Rebuild.** The build is reproducible: file times are the commit time (`SOURCE_DATE_EPOCH`, `rewrite-timestamp`), the base image is pinned by digest (`Dockerfile`), there are no npm dependencies, and no build-time labels. The tag build and the branch build of the same commit produce the same digest.
4. **Image contents.** The `Dockerfile` copies only `package.json` and `src/`, and records the source commit (`BUYIN_COMMIT`, shown in `/info`). There is no shell service, no debug container and no second process in the compose. The only non-public input is the encrypted environment variable `TEE_RPC_TOKEN` (§4.5), which cannot change code.
5. **Keys → this TEE.** The engine creates its signing and encryption keys at start (`src/Engine.js` constructor, `crypto.generateKeyPairSync`) and asks dstack for a quote whose `report_data` = `SHA-256(stableStringify({ ecdh, sig }))` of the public keys (`src/attest.js` `reportDataFor`). So every signature and every hole-card envelope can be tied to code running inside this measured TEE. Private keys are never exported (no code path writes or returns them).
6. **Every restart is recorded.** At each start the engine appends an `engine-key` line with its public keys, version and `composeHash` to the append-only record chain (`src/store.js` `appendEngineKey`), so the history of what ran is public at `/records/keys`.

**What the operator could try, and what happens:**

- *Run modified code.* Any change to code or compose changes the image digest and/or `composeHash`, and the new engine has new keys with a quote that shows the new measurement. It is visible in `/info`, in `/records/keys`, and to every browser that checks the attestation (`src/public/table/js/vault.js` `checkAttestation`). The published values for each release are the reference.
- *Swap the image under the same tag.* Impossible: the compose pins a digest, not a tag.
- *Change GitHub after the fact.* Does not change what runs; the digest ties the running image to one exact commit, which anyone can rebuild.

`/review/manifest` lists every file the running engine loads with its SHA-256 and a tree hash. Compare it with `sha256sum` of the files at the commit, or run `tools/check-deployment.js`.

---

## 2. Before the first hand: who may sit, with which keys

- **Seat tickets.** The operator's console signs a single-use ticket (amount, table rules, player id) with the console key whose *public* half is in the measured compose (`TEE_CONSOLE_KEY`). The table server verifies it (`src/table/ticket.js` `verifyTicket`) and refuses reuse (`src/table/TableServer.js` `join`, `usedTickets`, persisted as `seat-in` lines in the chain). The ticket contains no cards and no keys.
- **Session token.** `join` returns a random 24-byte token only in the HTTP response to the browser that joined. The event stream takes it in the `Authorization` header and table commands in the POST body (`src/table/http.js`); it is never put in a URL.
- **Player keys.** The browser creates two non-extractable WebCrypto key pairs (ECDSA for signing, ECDH for receiving cards) and stores them in IndexedDB on this TEE's origin (`src/public/table/js/vault.js` `loadKeys`). It registers the public keys with a self-signed proof (`register` message); the engine replies with an engine-signed confirmation that the browser verifies against the attested engine key (`src/public/table/js/app.js` `registerKeys`). The operator never sees the private keys, and cannot register keys for a seat: it does not hold the seat's token, and a seat whose signing key changes after sitting down is closed.
- **The page itself** is served by the engine from the image (`src/public/table/`), with `Content-Security-Policy: connect-src 'self'; frame-ancestors 'none'` (`src/table/http.js` `PAGE_HEADERS`): it can only talk to this TEE and cannot be embedded by another site.
- **The table's verification badge** checks, in the browser, that the engine key in use is the one in the quote's `report_data` and that every card matches its commitment (`vault.checkAttestation`, `checkOpening`). It does not verify Intel's signature on the quote; that is done outside the page (Phala explorer, `dcap-qvl`, `tools/check-deployment.js`), §8.

---

## 3. The deck cannot be chosen, predicted or changed

Implemented in `src/cards.js` and `src/Engine.js` `startHand`:

1. For every hand the engine draws a fresh 32-byte seed inside the TEE (`cards.newSeed`, `crypto.randomBytes`) and publishes only its commitment `seedCommit = SHA-256(seed)` **before** the hand (`Engine.openTable`, and `nextSeedCommit` after every hand).
2. Each player adds their own random value, signed against that `seedCommit` (`vault.msg.entropy`, `Engine.addEntropy`). **A seat that has not added a value for the current commitment is not dealt in** (`TableServer._eligible`). Values received after the commitment cannot influence the already-fixed seed, and the seed is unknown to players, so neither side can steer the result.
3. The deck order is `shuffledDeck(seed, handId, entropies)`: an HMAC-SHA-256 key over the seat-ordered entropies drives an unbiased Fisher–Yates shuffle (`cards.shuffleKey`, `Drbg.below`).
4. The engine publishes 52 card commitments `SHA-256("pz-card-v1|handId|i|card|salt")` at the start of the hand (`cards.commitDeck`, broadcast in the `hand` event). Every card later revealed comes with its salt and is checked against its commitment in the browser: the player's own hole cards (`app.js` `openHole`) and every public card — board, run-out, showdown and the after-hand board peek (`app.js` `checkPublic`), all via `vault.checkOpening`. A mismatch turns the table's verification badge to "check needed".
5. After the hand the record contains the seed, the entropies with their signatures and the deck; `src/verify.js` recomputes the commitment, the shuffle and all 52 commitments and fails on any difference.

Nobody, including the TEE code, can change the deck after the commitments are published, and the code that draws the seed is the measured code of §1.

---

## 4. During a hand nobody else can see the cards

### 4.1 Where cards exist
Only in the engine's memory inside the TEE (`HandCore`), protected by A1.

### 4.2 Hole cards go only to their owner, encrypted
`Engine.startHand` seals each seat's two cards with ECDH(engine key, that seat's registered key) → HKDF-SHA-256 → AES-256-GCM (`src/crypto.js` `sealEnvelope`). The table server sends each envelope only to that seat's own connections (`TableServer._startHand` → `_send(s, 'hole', …)`); the reconnect snapshot contains only the requester's own envelope (`TableServer.snapshot`). Only the player's non-extractable browser key can open it (`vault.openEnvelope`).

### 4.3 Board cards
Released only when the betting round is complete (`HandCore.status` → `advance`, `Engine.board`), and run out only when no more betting is possible (`runout`).

### 4.4 Showdown
Hole cards of players still in the hand are revealed to the table only at showdown or all-in run-out, as in any poker game. Folded hands are never revealed during play.

### 4.5 The operator's channels during a hand
| Channel | What it can do |
|---|---|
| `/rpc` (operator token) | In table mode (on when the measured compose sets `TEE_CONSOLE_KEY`) it answers **only** `info`; every game method returns 403 (`src/server.js` `RPC_IN_TABLE_MODE`; `test/server.test.js`). No hands opened, no actions, no key changes, no aborts. |
| `src/outbox.js` → `TEE_CONSOLE_URL` (engine sends) | The lines of the record chain, in order. A hand is appended **only when it is closed** (`Engine._closeHand` → `onRecord` → `RecordStore.appendHand`). A running hand is not in the chain, so it cannot be sent. |
| `/table/*` | Needs a seat token, which only the seated browser has. |
| Logs | The engine prints no cards (only the start line and a pot-validation warning). Logs are not public. |
| Disk | Encrypted by dstack with a key only this app receives (A2); holds only closed hands. |
| Network | TLS to the TEE (A2). The browser↔TEE traffic does not pass through the operator's servers. |

The `TEE_RPC_TOKEN` therefore only decides who may read **finished** hands.

### 4.6 Seats controlled by the operator
The operator issues tickets, so it can seat accounts like any player — its own, or (since it passes tickets on) a seat in another player's name. Such a seat receives exactly what any player receives: its own two cards and public information. It cannot see other seats' cards (4.2). Who sits where, impersonation and collusion are not program questions; they are checked after the fact from the signed records (every seat's key and every action are in them).

---

## 5. Nobody can bet for a player

- Nobody but the player can bet, call, raise or go all-in for them. Every chip-moving action carries the player's signature over `["pz-act-v1", handId, turnNumber, action, amount]` and the engine verifies it against the key fixed at hand start (`src/HandCore.js` `apply`, `C.verify`). A signature cannot be replayed on another turn or hand.
- Turn order is enforced (`strictOrder`): only the seat to act may act.
- The only actions without the player's signature are **check or fold on timeout** and **fold when the player leaves**, made by the table server inside the TEE (`TableServer._timeout`, `_leave`); `HandCore` refuses anything else from the host (`host can only fold or check`), and the record marks them as `host`. The turn timer runs in the TEE. The operator is not on the network path between the browser and the TEE (TLS via the dstack gateway, A2), so it cannot delay or drop one player's messages; it can only stop the whole service (availability).
- Keys used in a hand are fixed when it starts; a key change applies only from the next hand and is confirmed by an engine signature the browser checks.

---

## 6. Results and the record cannot be changed

- Results, pots, side pots, rake and payouts are computed by the engine (`HandCore.showdown` / `uncontested`, `PotManager`, `HandEvaluator`) with the rake rule from the seat ticket.
- The full hand record is signed with the attested engine key (`Engine._closeHand`) and appended to a SHA-256 hash chain on the TEE disk (`src/store.js`); `/records/head` only grows and any finished hand has a public receipt (`/records/receipt/<id>`, no cards).
- The player's own browser can fetch its hands with its own key (`POST /records/mine`, no operator token) and replay them with the engine's own files (`/table/verify.html`). It remembers the chain length it has seen and warns if it ever shrinks.
- Payouts: the engine signs what each seat leaves with (`TableServer._settle`, amounts only) and keeps it in the chain. The operator holds the money and pays out; the protocol makes any short payment provable (the signed note), it does not force payment.
- Retention: records stay on the TEE disk for `TEE_RETENTION_DAYS` (90, in the measured compose). Day files past that age that were already sent to the console are deleted by the engine itself (`RecordStore.prune`); the kept chain continues from the `prev` hash of its first line.
- Removal of history: the chain detects any change or removal inside it. Deleting the whole store (or rolling it back) is prevented by A2 (the disk is the app's, encrypted with its key) and detected by anyone who saved an earlier `/records/head` — every player's verification page saves the length it has seen and warns if it shrinks.

---

## 7. What remains, stated plainly

- A1–A4 above.
- The operator controls availability (it can stop the service) and money custody (balances live on its side), and it decides who may log in and sit. It cannot alter a hand or see cards while a hand is played.
- Restarts: if the engine is restarted (a new deployment or a crash), the hand in progress is voided and every seat keeps its stack from before that hand (`TableServer._recover`); nobody can choose its outcome, and every start is a new key line in `/records/keys`. Voiding is an availability action, not a way to change a result.
- Upgrades: the operator can deploy a new version. A new version is a different measurement with different keys; it is visible in `/info` and `/records/keys` and must match a published release to be trusted. Players and reviewers check the live `composeHash`/image digest against the release (`tools/check-deployment.js`).

---

## 8. How to check, step by step

1. Open the TEE address (`/`, `/info`) and note `commit`, the image digest and `composeHash`.
2. Verify the quote (Intel signature) with https://proof.t16z.com or `dcap-qvl`; confirm its `report_data` equals SHA-256 of the engine public keys in `/info`.
3. Confirm `SHA-256(appCompose) = composeHash`, read the pinned image digest, and confirm it is the digest built from the release tag (rebuild, or compare with the release's Actions log).
4. Compare `/review/manifest` with the files at that commit (`tools/check-deployment.js` does 2–4 automatically; for the Intel signature it uses the explorer).
5. Read §2–§6 against the code. The claims are local: each is enforced in the named function.
