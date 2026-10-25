# Pairing allowlist read attribution

## Acceptance rule, registered before measurement

Use current-main source and an isolated Gateway with synthetic state, loopback
transports and bundled channel owners. Never read operator state or logs. The
first target is the remaining `channel_pairing_allow_entries` SELECT, observed
at 58.7 per 15 minutes after the iMessage lazy-read change.

Reuse `scripts/perf/plugin-state-polling.mts --messages 0 --seconds 60` for an
empty Reef inbox and `--messages 18 --seconds 60` for pending reviews. Use
`scripts/bench-ingress-polling.mts --idle-seconds 60 --sparse-events 0` for the
iMessage idle control. Count all-thread SQL, worker requests, and main-thread
SQL with the frozen v3.1.4 observer, verified against its frozen hashes. Keep
boot, the 40-second Reef settle window, steady state and shutdown separate.
Profile the real Gateway with `--cpu-prof` per thread. Report statements per
poll, per minute and per 15 minutes; record errors and unexpected relay calls.

Inventory every bundled pairing consumer by channel, caller and trigger before
proposing a change. Distinguish source-only attribution and owner tests from
real-Gateway transport evidence; an unexercised channel is an explicit gap.

A proposed deletion must remove discarded work or reuse the existing owner's
recorded fact without weakening ingress admission, revocation, one-shot approval
consumption or external-effect authority. No schema, freshness probe, generation,
or new cache is authorized by this attribution task. Stop after posting the
measured attribution and design for coordinator approval.

After approval, require a count regression red on base, refused ingress after
allow-entry revocation, affected owner suites and PostgreSQL review. Counts use
three alternating baseline/candidate pairs when load is below 64 and internal
free space at least 12 GiB, otherwise one pair with the limit stated. A wall-time
or CPU-speed claim needs the timing lock, load below 24 and at least five
interleaved samples per arm, with cold/warm median, p95 and range separate.
Every user-facing metric must hold or improve; any adverse 20% cell stops the
change. Runtime MAIN must remain zero and total work must not increase.
