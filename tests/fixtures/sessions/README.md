# Recorded sessions

Bridge streams captured from a live game, replayed through the real engine by
`tests/support/replay.ts`.

To record one: run the plugin, open the probe page, play through whatever you
want covered, then press **Copy session JSON** and save it here.

This replaces Alt1's `PasteInput` workflow and covers strictly more. That let a
single screenshot be pasted into an ordinary browser and run through one reader.
A session is a whole timeline, exercising the engine, the alerters, the login
gate and per-alerter cadence together — and most alerting bugs are about timing,
ordering and staleness, none of which a single frame can express.

Time is virtual during replay, so an hour-long session runs instantly and
deterministically.
