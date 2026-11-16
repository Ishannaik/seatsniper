# Operations

The bot keeps everything in one SQLite file, set by `DB_PATH` (see
[`.env.example`](../.env.example)). A host install defaults to `seatsniper.db` in
the working directory; `docker-compose.yml` sets `/data/seatsniper.db`, inside the
`seatsniper_data` volume. Run the SQL below against that file.

## Clean orphan `seen_dates` / `seen_venues` rows

If the bot ran with SQLite `foreign_keys` disabled, `/stop` can leave orphan
rows in the `seen_dates` and `seen_venues` ledgers. This one-shot cleanup removes
them for self-hosted deployments:

```sql
-- orphans after /stop when foreign_keys was off
DELETE FROM seen_dates WHERE watch_id NOT IN (SELECT id FROM watches);
DELETE FROM seen_venues WHERE watch_id NOT IN (SELECT id FROM watches);
```

Before running it:

1. Stop the bot, or accept SQLite WAL quirks from a live writer.
2. Back up the database file.

Enabling the `foreign_keys` pragma prevents the orphan rows from recurring; see
the foreign-keys companion work for the runtime setup.
