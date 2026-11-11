# BUY-IN Engine

The hold'em game engine for BUY-IN — *nothing hidden, everything proven*. It is open source so anyone can check that the game is fair. It is built to run inside a Trusted Execution Environment (TEE).

The operator's servers handle lobbies, timers, animations and wallets. They never hold the deck, and they do not decide which cards are dealt or who wins.

## Guarantees

| Guarantee | How |
|---|---|
| Nobody can pick the deck, including the engine and the operator | The engine commits to `SHA-256(seed)` before the hand. Players then add their own random values. The shuffle is `HMAC-SHA256(seed, [handId, player values])`, and the seed is revealed after the hand. |
| Cards cannot change mid-hand | All 52 card commitments `SHA-256(handId \| i \| card \| salt)` are published when the hand starts. Each revealed card comes with its salt, and the player's browser checks it immediately. |
| The operator cannot see your hole cards | Hole cards are encrypted to your browser's key: ECDH P-256 → HKDF-SHA256 → AES-256-GCM. The operator's server only relays the ciphertext. |
| The board is never shown early | The engine reveals a street only after its own copy of the betting rules says the round is over. |
| Nobody can spend your chips for you | Calls, bets, raises and all-ins need your ECDSA signature, bound to this hand and this turn number. The operator can only fold or check for you (timeouts, leaving), and the hand record shows each time it did. A tip to another player also needs your signature (numbered, so it cannot be replayed) and is kept in the record chain with that signature. |
| The rake follows the table rule | The engine takes the rake itself, using the table's published percent and minimum pot. Split pots are not raked, and each player's share is computed from what they actually matched. The rule and every share are in the signed record. |
| Results can be re-checked | Every hand ends with a record signed by the engine. `src/verify.js` replays it from the seed and fails on any difference. |

## Layout

```
src/cards.js        deck, deterministic shuffle, card commitments
src/crypto.js       keys, signatures, hole-card envelopes, signed message formats
src/HandCore.js     one hand: blinds, betting, round end, run-out, showdown, pots
src/Engine.js       tables, player keys, seed commitments, the engine API the table server calls
src/server.js       HTTP server: GET /info (public keys + attestation), records, review manifest; no operator route
src/outbox.js       sends the record chain to the console (TEE_CONSOLE_URL)
src/attest.js       binds the engine keys to the TEE quote (dstack / Phala Cloud, Intel TDX)
src/store.js        hand records kept on the TEE disk as a hash chain in one SQLite file (Node's built-in node:sqlite); schema and SQL are in this file
src/verify.js       hand record verifier (CLI and module)
src/table/          table server: seat tickets signed by the console, turns and timers, settlement notes (amounts only)
src/public/table/   the table screen the TEE serves itself at /table/ (plain JS, no build step, no third-party code); images and fonts come from the console's resource server
src/consoleApi.js   console checks of finished hands only (results, signed records); takes only the record store
LICENSE             all rights reserved — published for verification only
RULES.md            development rules (Korean): no secrets, no backdoors, no dependencies
Dockerfile          the image that runs in the TEE (built by GitHub Actions, see .github/workflows)
AUDIT.md            step-by-step checks and the threat model, for human and AI reviewers
PROOF.md            why the game cannot be manipulated before a hand is played — each claim with the code that enforces it
tools/              check-deployment.js: checks the live engine against a checkout of its commit (no dependencies)
```

There are no runtime dependencies; the engine uses only Node's built-in `crypto`.

## Verify a hand

```
node src/verify.js record.json engine-key.json
```

- `record.json` is `{ record, sig }`, as stored by the operator after the hand.
- `engine-key.json` is the engine's public signing key (a JWK) from `/info`.
- Verify with the same engine version that made the record (`record.engine.version`, e.g. git tag `tee-engine-v0.2.0`). The rules can change between versions; for example, 0.2.0 added the rake to the record.
  - Once the engine runs in a TEE, this key is bound to the hardware attestation of this exact code.

## Verify the engine itself (attestation)

The engine runs in an Intel TDX confidential VM on Phala Cloud (dstack). At start it creates its keys and asks the TEE for a quote whose `report_data` is

```
SHA-256( stableStringify({ ecdh: <engine ECDH JWK>, sig: <engine signing JWK> }) )
```

`GET /info` returns the keys and the attestation (`quote`, `eventLog`, `reportData`, `appId`, `composeHash`). To check it:

1. Check the quote is genuine Intel TDX hardware — Phala's verifier (`https://cloud-api.phala.com/api/v1/attestations/verify`) or Intel DCAP (`dcap-qvl`).
2. Check `report_data` matches the keys — `checkInfoBinding(info)` in `src/attest.js`. The private keys never leave the TEE.
3. Check the code — the compose hash in the event log must match the published `docker-compose.yml`, which pins the image by digest. The image digest is printed by the GitHub Actions run for the tagged commit.
4. The public report is at `https://trust.phala.com/app/<appId>`.

Every hand record is signed with the attested key, so a record that verifies with `src/verify.js` was produced by this code inside the TEE.

## Hand records stay in the TEE

When a hand ends, the engine appends its signed record to the SQLite file `/data/records/buyin.db` on the TEE data disk before the hand is closed. If the record cannot be written, the hand does not close and the operator voids it. The disk is encrypted with a key that only the TEE receives.

The records form a hash chain: each line holds the hash of the line before it, so deleting or changing a past record breaks every hash after it (`verifyChain` in `src/store.js`). Each time the engine starts it also writes its new public keys (and the attestation `report_data`) into the chain, so old records stay verifiable with old keys.

| Endpoint | Who | What |
|---|---|---|
| `GET /records/head` | anyone | `{ count, head, hands, first, sent, storage, retentionDays }` — the current end of the chain (save it; `count` can only grow), the first kept line, how far the console has received, and how much is stored |
| `GET /records/keys` | anyone | every engine key the chain has seen |

**Sending to the console.** The operator cannot read records out of the engine. Each line the engine writes to the chain (engine key, seat-in, settlement note, finished signed hand) is sent by the engine to `TEE_CONSOLE_URL` (in the measured compose — the only place the engine connects to), in order (`src/outbox.js`). The console answers with the next line number it expects; if one is missing the engine sends again from there, and failed sends are retried. A hand in play is not in the chain, so it cannot be sent.

**Checks for the console** (`src/consoleApi.js`, given only the record store). `GET /records/finished/<handId>` returns the signed record of a finished hand. `GET /records/results?from=&limit=` (console token) returns, for finished hands only, the seats, start and end stacks, rake and the record hash — no cards, deck or seed — so the console can check what it received. A hand in play is not in the chain, so no route can return it.

**Retention.** Records are kept on the TEE disk for `TEE_RETENTION_DAYS` days (7, measured). Lines past that age that were already sent are deleted; the kept chain continues from the `prev` hash of its first line.

**SQLite.** The store uses Node's built-in `node:sqlite` (no third-party code). SQLite has no users or passwords; the file is on the TEE's encrypted disk and only this program opens it, so nothing about it is secret — the schema and every SQL statement are in `src/store.js`. A trigger refuses any `UPDATE` of a chain line, another refuses deleting a line not yet sent to the console, and on every start the engine recomputes the whole chain and refuses to start if any line differs. The console keeps every record with the engine's signature.

## Rebuild the image yourself

The image build is reproducible: file times are the commit time and the image has no build-time labels.

```
git checkout v0.5.9
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build --platform linux/amd64   --provenance=false --sbom=false --output type=oci,dest=engine.tar,rewrite-timestamp=true .
```

The manifest digest of `engine.tar` must equal the digest pinned in `deploy/docker-compose.yml`.

## Test

```
npm test
```

The test suite covers:
- 3,000 random hands: chip conservation, record signature and replay
- tamper detection
- rejection of unsigned, mis-signed and stale-turn actions
- rejection of a mid-hand key swap and of an early board
- input validation

## Licence

All rights reserved (see `LICENSE`). The code is published for inspection and verification only; it may not be copied, reused or hosted. Images, fonts and other design assets are not part of this repository.

## Status

- **Stage 1–2:** the engine runs as a separate process (`mode: "dev"`). The cryptographic guarantees above hold, but there is no hardware attestation.
- **0.10.2:** table page: a seat ticket in the address (coming back from the lobby) is used before a table token left in the tab, so a player who bought in again sits down with the new ticket instead of reattaching to the settled seat. No engine code changed
- **0.10.1:** re-buy after going bust uses the normal sit-down path: a seat that loses all its chips is settled at 0 at once (settlement note as before) and the seat is held for that player for 10 minutes (shown as all-in out, no hands, no tips); "ask for buy-in" shows a bubble and takes the player to the lobby buy-in request; the new console-signed seat ticket seats them back in the held seat. The 0.10.0 top-up route (`POST /table/topup`), top-up receipts and the `rebuy-ask`/`topup` chain lines are removed — chips enter a seat only with a seat ticket
- **0.10.0:** a seat that loses all its chips stays at the table (shown as all-in out) instead of being settled. The player can ask for another buy-in (`rebuy` command, chain line `rebuy-ask`); the console passes it to the host and, if approved, sends a console-signed top-up receipt to `POST /table/topup` (console token). The engine accepts it only for a seat with 0 chips that asked, once per receipt, between hands (chain line `topup`, also listed on the public table record). The settlement note's `buyIn` is the sum of all buy-ins. Hand rules, deck and verification are unchanged.
- **0.9.23:** a hand's full record (with every seat's hole cards) is given to the player who sat only after the table closes; while the table is open `/records/mine` lists the hand as `open` and the verify page shows "in progress" instead of check results
- **0.9.22:** a table's record and its hands' receipts open only after the table closes; while it is open both answer exactly like an unknown id (404), so nobody outside can tell which games are in play. No game code changed.
- **0.9.21:** the public table record also lists the table's tips in chain order (seat to seat, amount, signed by the sender), so chip changes between hands are explained on the same page. No game code changed.
- **0.9.20:** the public table record also re-checks every hand inside the engine with `src/verify.js` (`src/tableRecord.js`): engine signature, seed = the commitment announced before the hand, deck = shuffle of seed + the players' signed random values, card commitments, and a replay of every action giving the same cards, board, result and chips. Only PASS/FAIL and the reason are shown — no cards, deck or seed. No game code changed.
- **0.9.19:** public table record `GET /records/table/<tableId>` (JSON) and `.html` (for AI web tools): every finished hand of the table with seat numbers, chips at start and end, rake, chain position and receipt — no cards, deck, seed or member numbers. A player compares the game record the operator showed them with this page. No game code changed.
- **0.9.18:** `/ai.html` makes every address a real link, so AI web tools follow it instead of retyping long hashes. No game code changed.
- **0.9.17:** at start the engine submits its own quote (public data) to the Phala TEE Attestation Explorer (`src/explorer.js`) and the audit report links the explorer report directly — no operator server in between. This is the engine's second outbound connection; it sends only the quote. No game code changed.
- **0.9.16:** the audit report lists a link to the independent check of the live quote (Phala TEE Attestation Explorer, via the page in `TEE_ATTEST_LINKS`), with the current composeHash in the address so each deployment has its own address. The engine only prints the link; it makes no connection there. No game code changed.
- **0.9.15:** the engine runs on the production OS image `dstack-0.5.12` (no SSH debug shell); `deploy/tee-os.txt` at this commit declares it. No game code changed.
- **0.9.14:** the audit report is also served as HTML at `/ai.html` and the file list as JSON at `/review/manifest.json` — some AI web browsers cannot read `text/markdown` or `text/plain`, so they could not compare the live values. Same content as `/` and `/review/manifest`. No game code changed.
- **0.9.13:** the font that draws card ranks and suits is now inside the image (`src/public/table/font/`, DejaVu Sans with its license; CSP `font-src 'self'`) — before, it came from the operator's resource server, so a changed font file could have changed how a card looks. The other design files (images, sounds, videos) stay on the resource server; their SHA-256 are published in `resources.sha256` and `tools/check-resources.js` compares them with what the server sends. No game code changed.
- **0.9.12:** the engine is also served at **https://tee.buyinholdem.com** — the pinned `dstack-ingress` container in the same TEE gets the TLS certificate and terminates TLS there (the certificate key never leaves the TEE; a CAA record limits issuance to that account). The deployment adds one more encrypted secret, a DNS-only Cloudflare token for buyinholdem.com; `tools/check-deployment.js` expects exactly `TEE_RPC_TOKEN` and `CLOUDFLARE_API_TOKEN`. No game code changed.
- **0.9.11:** table page loads the emote and gift pictures as soon as you sit down, so the pickers open with their pictures at once.
- **0.9.10:** table page matches the previous game's screen again: card faces, deal and flip animations, GAME START / SHOWDOWN banners, a "raising…" hint (new `raising` command, sent only on your turn), all-in flames, emote and tip pickers next to your name, rabbit hunt (board cards that were not dealt, shown after a fold-out from the result's `peekBoard`), in the dark (new `dark` command: hide your own cards for one hand), check/fold pre-action, a bottom-left chat panel with translation (received chat text only goes to the operator's translation address), room / hand label and a volume setting. No rule about cards or chips changed.
- **0.9.9:** the service domain is now buyinholdem.com: the table page loads design files from `resource.buyinholdem.com` (CSP updated) and the engine sends its record chain to `https://buyinholdem.com/tee-records`. No game rule changed.
- **0.9.8:** tips are signed with the receiver's seat number (the page never sees another player's member id); a bad tip signature no longer looks like a lost seat.
- **0.9.7:** table page: action sounds, emotes, chat, a time bank (3 per seat, +20 s, one per turn) and tips (1 big blind, pre-flop only, signed by the sender, moved between hands and written to the record chain), as on the previous game. Design images can be versioned (`?v=`) so a change shows at once.
- **0.9.6:** table page: the phone preset buttons now really send the bet (in 0.9.5 a local name hid the action function, so a tap did nothing).
- **0.9.5:** a turn timeout folds that hand only and the player keeps the seat; three timeouts in a row (no own action in between) stand the player up and cash out, as on the previous game server. A disconnected player's turn is checked when possible, otherwise folded, and does not count. On phones the quarter / half / pot / all-in buttons bet at once; on PC they set the amount for the bet button.
- **0.9.4:** table page: each player gets one of several default avatars, chosen from the nickname (the same player always looks the same); images stay on the resource server.
- **0.9.3:** table page: on screens shorter than 900 px the player's own action label sits beside the avatar so it never covers a board card.
- **0.9.2:** table page: after the seat is closed (cash-out or no chips left) a "Back to lobby" button returns to the page the player came from; a player alone sees "Waiting for other players"; the result's hand name is no longer covered by the player's own action label.
- **0.9.1:** table page: one action per turn even on a double click (no false "action failed"), no favicon request; container logs capped (7 × 5 MB) in the measured compose.
- **0.9.0:** the record store is one SQLite file (`node:sqlite`, built into Node): indexed reads for results, finished hands, receipts and a player's hands; triggers make chain lines append-only and keep unsent lines; records from 0.8 day files are moved in once. Measured on 100,000 hands (a week): a finished hand by id 0.04 ms, 200 results 21 ms, append with fsync 1.4 ms.
- **0.8.2:** faster record store — sending to the console takes new lines from memory; a hand is read by its byte position; engine keys are kept in memory (no file scan per request); chain reads skip day files that end before the requested line.
- **0.8.1:** `tools/check-deployment.js` also checks that the server state is this repository: the measured deployment file is `deploy/docker-compose.yml` of a commit here, only the secret token is set outside it, and the OS image equals `deploy/tee-os.txt` (a `dstack-dev-*` image is flagged as development). The pre-game brief shows the OS image.
- **0.8.0:** the TEE keeps one week of records (`TEE_RETENTION_DAYS=7`, checked hourly; unsent records are never deleted). `GET /records/results` (console token) returns finished-hand results without cards for reconciliation; a hand in play cannot be read by any route.
- **0.7.1:** the operator route `/rpc` is removed (public rooms are not used; every hand runs in the TEE table server, and `TEE_CONSOLE_KEY` is required in dstack mode). The operator has no route into the engine.
- **0.7.0:** the engine sends its records to the console (`TEE_CONSOLE_URL`, retried, resent from the console's next number if one is missing); the operator's record export (`/records`, `/records/hand/<id>`) is removed. Records older than `TEE_RETENTION_DAYS` (90) that were sent are deleted. `/records/head` and `/info` show storage (bytes, files, oldest day, free disk) and how far the console has received.
- **0.5.9:** basic hardening — HTTP time limits and connection cap, rate limits (join, commands per seat, own-records, operator RPC), at most 3 event connections per seat, security headers on every response; the container runs with no Linux capabilities, no privilege escalation and a read-only root filesystem.
- **0.5.8:** the pre-game brief asks four closed questions (YES/NO) about card secrecy and one TRUE/FALSE conclusion.
- **0.5.7:** the 0.5.5 player-key binding is removed (seating and impersonation are checked after the fact from the records, not by the program); a player's new session closes the old seat; a seat whose signing key changes is closed.
- **0.5.6:** the pre-game brief at `/` asks one question — can anyone but the player see the cards during a hand — and `PROOF.md` opens with that claim. Table flow: a player who does not act on their turn folds and leaves; a player disconnected longer than the grace time (`TEE_DISCONNECT_GRACE_MS`) leaves; all-in players stay to the result; the game continues for the others.
- **0.5.4:** tag builds carry GitHub's signed build provenance and a Release listing digest, commit and build run; the table page checks every public card (board, run-out, showdown) against its commitment.
- **0.5.3:** the engine reports its source commit and the SHA-256 of every file it loads (`/review/manifest`); `/` is a pre-game brief that asks an AI to investigate this repository at that commit and check `PROOF.md`; `tools/check-deployment.js` checks the live engine against a checkout. Every dealt-in player must add random for the hand; the table event stream takes its token in a header.
- **0.5.2:** table mode closes the operator's game RPC (`/rpc` answers only `info`); the live audit report at `/` is written to be pasted into an AI reviewer as is.
- **0.5.0:** the TEE serves its own pages — the table at `/table/` and **Verify my hands** at `/table/verify.html`. A player's hand records come straight from the TEE to that page (`POST /records/mine`, signed with the player's key; no operator token), and the page replays them with the engine's own files. Public receipts: `GET /records/receipt/<handId>`.
- **Table server (in progress):** with `TEE_CONSOLE_KEY` set, the engine also runs the table and serves the table screen at `/table/`. The player's browser talks only to the TEE (`connect-src 'self'` plus fixed sound files from the resource server's `sfx/` folder and one chat-translation address that receives only chat text, no framing): seat ticket in, cards and turns out over SSE, signed actions back. The operator's server sees settlement notes (amounts) and, after each hand, the signed hand record.
- **Stage 3 (now):** the engine runs in a TDX TEE on Phala Cloud (`mode: "dstack"`), binds its keys to the hardware quote, keeps every hand record on the TEE disk (0.4.0), and the build is reproducible. The player's browser checks the key ↔ quote binding itself.

## Third-party assets

`src/public/table/font/dejavu-sans.woff2` is DejaVu Sans (Bitstream Vera / DejaVu license, free to redistribute). It is used only for the card suit symbols.
