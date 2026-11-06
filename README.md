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
| Nobody can spend your chips for you | Calls, bets, raises and all-ins need your ECDSA signature, bound to this hand and this turn number. The operator can only fold or check for you (timeouts, leaving), and the hand record shows each time it did. |
| The rake follows the table rule | The engine takes the rake itself, using the table's published percent and minimum pot. Split pots are not raked, and each player's share is computed from what they actually matched. The rule and every share are in the signed record. |
| Results can be re-checked | Every hand ends with a record signed by the engine. `src/verify.js` replays it from the seed and fails on any difference. |

## Layout

```
src/cards.js        deck, deterministic shuffle, card commitments
src/crypto.js       keys, signatures, hole-card envelopes, signed message formats
src/HandCore.js     one hand: blinds, betting, round end, run-out, showdown, pots
src/Engine.js       tables, player keys, seed commitments, RPC entry point
src/server.js       HTTP server: POST /rpc (operator only, bearer token), GET /info (public keys + attestation)
src/attest.js       binds the engine keys to the TEE quote (dstack / Phala Cloud, Intel TDX)
src/store.js        hand records kept on the TEE disk as an append-only hash chain
src/verify.js       hand record verifier (CLI and module)
src/table/          table server: seat tickets signed by the console, turns and timers, settlement notes (amounts only)
src/public/table/   the table screen the TEE serves itself at /table/ (plain JS, no build step, no third-party code)
RULES.md            development rules (Korean): no secrets, no backdoors, no dependencies
Dockerfile          the image that runs in the TEE (built by GitHub Actions, see .github/workflows)
client/             the player's browser side: keys, opening hole cards, checking commitments and the attestation
AUDIT.md            step-by-step checks and the threat model, for human and AI reviewers
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

When a hand ends, the engine appends its signed record to `/data/records` on the TEE data disk before the hand is closed. If the record cannot be written, the hand does not close and the operator voids it. The disk is encrypted with a key that only the TEE receives.

The records form a hash chain: each line holds the hash of the line before it, so deleting or changing a past record breaks every hash after it (`verifyChain` in `src/store.js`). Each time the engine starts it also writes its new public keys (and the attestation `report_data`) into the chain, so old records stay verifiable with old keys.

| Endpoint | Who | What |
|---|---|---|
| `GET /records/head` | anyone | `{ count, head, hands }` — the current end of the chain. Save it; it can only grow. |
| `GET /records/keys` | anyone | every engine key the chain has seen |
| `GET /records/hand/<handId>` | operator (token) | one hand record with its chain position — past cards are in it |
| `GET /records?from=&limit=` | operator (token) | chain export for backup and audit |

## Rebuild the image yourself

The image build is reproducible: file times are the commit time and the image has no build-time labels.

```
git checkout v0.4.0
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

## Status

- **Stage 1–2:** the engine runs as a separate process (`mode: "dev"`). The cryptographic guarantees above hold, but there is no hardware attestation.
- **Table server (in progress):** with `TEE_CONSOLE_KEY` set, the engine also runs the table and serves the table screen at `/table/`. The player's browser talks only to the TEE (`connect-src 'self'`, no framing): seat ticket in, cards and turns out over SSE, signed actions back. The operator's server sees settlement notes (amounts) and, after each hand, the signed hand record.
- **Stage 3 (now):** the engine runs in a TDX TEE on Phala Cloud (`mode: "dstack"`), binds its keys to the hardware quote, keeps every hand record on the TEE disk (0.4.0), and the build is reproducible. The player's browser checks the key ↔ quote binding itself.

## Third-party assets

`src/public/table/font/dejavu-sans.woff2` is DejaVu Sans (Bitstream Vera / DejaVu license, free to redistribute). It is used only for the card suit symbols.
