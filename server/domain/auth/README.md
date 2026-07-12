# Authentication domain

This module keeps account input, credential hashing, session rotation, and
process-local abuse limits independent from HTTP routing and persistence.

- `credentials.ts` owns username normalization/validation, SHA-256 bearer-token
  fingerprints, and the versioned scrypt password format.
- `sessions.ts` computes bounded token-set issuance, eviction, revocation, and
  legacy token migration without mutating a player record.
- `rate-limits.ts` owns deterministic login and guest-creation limit decisions;
  callers provide the clock so the same policy can later move to Redis without
  changing account behavior.

`game.ts` remains the application adapter: it turns rejected domain decisions
into the existing API errors and commits returned token sets to storage.
