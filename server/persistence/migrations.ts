import { createHash } from 'node:crypto'
import type { SqlDatabase } from './postgres/database'

export interface Migration {
  version: number
  name: string
  sql: string
}

const CORE_SQL = String.raw`
CREATE TABLE accounts (
  id text PRIMARY KEY,
  username_key text UNIQUE,
  password_hash text,
  registered boolean NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT account_registration_consistent CHECK (
    (registered AND username_key IS NOT NULL AND password_hash IS NOT NULL)
    OR (NOT registered AND username_key IS NULL AND password_hash IS NULL)
  )
);

CREATE TABLE player_profiles (
  player_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  username text NOT NULL,
  trophies integer NOT NULL CHECK (trophies >= 0),
  shield_until timestamptz,
  last_seen_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  revenge_rights jsonb NOT NULL DEFAULT '{}'::jsonb,
  bot_raid_cooldowns jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  player_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  device_id text
);
CREATE INDEX sessions_player_id_idx ON sessions(player_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE world_realms (
  id text PRIMARY KEY,
  generator_version integer NOT NULL CHECK (generator_version > 0),
  created_at timestamptz NOT NULL,
  accepting_players boolean NOT NULL DEFAULT true
);
INSERT INTO world_realms(id, generator_version, created_at) VALUES ('main', 1, NOW());

CREATE TABLE world_plots (
  world_id text NOT NULL REFERENCES world_realms(id),
  x integer NOT NULL,
  y integer NOT NULL,
  player_id text NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plot_version bigint NOT NULL CHECK (plot_version > 0),
  assigned_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  PRIMARY KEY (world_id, x, y)
);
CREATE INDEX world_plots_region_idx ON world_plots(world_id, (floor(x / 32.0)), (floor(y / 32.0)));
CREATE INDEX world_plots_lease_idx ON world_plots(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

CREATE TABLE villages (
  player_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  buildings jsonb NOT NULL,
  obstacles jsonb NOT NULL,
  army jsonb NOT NULL,
  wall_level integer NOT NULL CHECK (wall_level >= 1),
  gold numeric(30, 12) NOT NULL CHECK (gold >= 0),
  ore bigint NOT NULL CHECK (ore >= 0),
  food bigint NOT NULL CHECK (food >= 0),
  production_remainders jsonb NOT NULL,
  population jsonb NOT NULL,
  simulated_through timestamptz NOT NULL,
  last_mutation_at timestamptz NOT NULL,
  layout_revision bigint NOT NULL CHECK (layout_revision >= 0),
  economy_revision bigint NOT NULL CHECK (economy_revision >= 0),
  simulation_version integer NOT NULL CHECK (simulation_version > 0),
  next_event_at timestamptz,
  CONSTRAINT buildings_array CHECK (jsonb_typeof(buildings) = 'array'),
  CONSTRAINT obstacles_array CHECK (jsonb_typeof(obstacles) = 'array'),
  CONSTRAINT army_object CHECK (jsonb_typeof(army) = 'object'),
  CONSTRAINT population_object CHECK (jsonb_typeof(population) = 'object')
);
CREATE INDEX villages_next_event_idx ON villages(next_event_at) WHERE next_event_at IS NOT NULL;

CREATE TABLE idempotency_keys (
  actor_id text NOT NULL,
  operation text NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  response jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id, operation, request_id),
  CONSTRAINT completed_has_response CHECK (state <> 'completed' OR response IS NOT NULL)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);

CREATE TABLE operation_markers (
  player_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  marker_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(player_id, kind, marker_key)
);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  CONSTRAINT outbox_lock_consistent CHECK ((locked_by IS NULL) = (locked_until IS NULL))
);
CREATE INDEX outbox_delivery_idx ON outbox_events(available_at, id) WHERE published_at IS NULL;

CREATE TABLE legacy_import_manifest (
  collection text NOT NULL,
  record_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL,
  PRIMARY KEY(collection, record_key)
);
`

const BATTLES_SQL = String.raw`
CREATE TABLE attacks (
  id text PRIMARY KEY,
  attacker_id text NOT NULL REFERENCES accounts(id),
  defender_id text REFERENCES accounts(id),
  target_kind text NOT NULL CHECK (target_kind IN ('player', 'bot', 'scenario')),
  target_id text NOT NULL,
  world_id text NOT NULL REFERENCES world_realms(id),
  target_x integer NOT NULL,
  target_y integer NOT NULL,
  target_plot_version bigint NOT NULL CHECK (target_plot_version > 0),
  state text NOT NULL CHECK (state IN ('preparing', 'engaged', 'active', 'finalizing', 'settled', 'cancelled', 'expired')),
  state_version bigint NOT NULL CHECK (state_version >= 0),
  simulation_version integer NOT NULL CHECK (simulation_version > 0),
  seed text NOT NULL,
  fencing_token_hash text NOT NULL,
  defender_snapshot jsonb NOT NULL,
  reserved_army jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  engaged_at timestamptz,
  updated_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  ended_at timestamptz,
  result jsonb,
  CONSTRAINT terminal_attack_has_end CHECK (
    state NOT IN ('settled', 'cancelled', 'expired') OR ended_at IS NOT NULL
  ),
  CONSTRAINT attack_target_consistent CHECK (
    (target_kind = 'player' AND defender_id IS NOT NULL AND target_id = defender_id)
    OR (target_kind IN ('bot', 'scenario') AND defender_id IS NULL)
  )
);
CREATE UNIQUE INDEX attacks_one_outgoing_idx ON attacks(attacker_id)
  WHERE state IN ('preparing', 'engaged', 'active', 'finalizing');
CREATE UNIQUE INDEX attacks_one_defender_lease_idx ON attacks(defender_id)
  WHERE target_kind = 'player' AND state IN ('engaged', 'active', 'finalizing');
CREATE INDEX attacks_deadline_idx ON attacks(deadline_at)
  WHERE state IN ('preparing', 'engaged', 'active', 'finalizing');
CREATE INDEX attacks_defender_history_idx ON attacks(defender_id, created_at DESC);

CREATE TABLE attack_commands (
  attack_id text NOT NULL REFERENCES attacks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  actor_id text NOT NULL REFERENCES accounts(id),
  request_id text NOT NULL,
  command_type text NOT NULL,
  payload jsonb NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY(attack_id, sequence),
  UNIQUE(attack_id, request_id)
);

CREATE TABLE attack_settlements (
  attack_id text PRIMARY KEY REFERENCES attacks(id),
  attacker_id text NOT NULL REFERENCES accounts(id),
  defender_id text REFERENCES accounts(id),
  outcome jsonb NOT NULL,
  committed_at timestamptz NOT NULL
);

CREATE TABLE balance_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id text NOT NULL REFERENCES accounts(id),
  operation text NOT NULL,
  request_id text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('gold', 'ore', 'food', 'trophies')),
  delta numeric(30, 12) NOT NULL,
  balance_after numeric(30, 12) NOT NULL CHECK (balance_after >= 0),
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(player_id, operation, request_id, currency)
);
CREATE INDEX balance_ledger_player_history_idx ON balance_ledger(player_id, created_at DESC, id DESC);

CREATE TABLE replay_chunks (
  attack_id text NOT NULL REFERENCES attacks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  format text NOT NULL,
  payload jsonb,
  object_key text,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(attack_id, sequence),
  CONSTRAINT replay_payload_location CHECK ((payload IS NULL) <> (object_key IS NULL))
);

CREATE TABLE notifications (
  player_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  read_at timestamptz,
  PRIMARY KEY(player_id, id)
);
CREATE INDEX notifications_unread_idx ON notifications(player_id, occurred_at DESC) WHERE read_at IS NULL;

CREATE TABLE economy_ledger_days (
  day integer PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL
);
`

const EXPANDABLE_WORLD_SQL = String.raw`
CREATE TABLE world_regions (
  world_id text NOT NULL REFERENCES world_realms(id),
  region_x integer NOT NULL,
  region_y integer NOT NULL,
  region_id text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 1024),
  generation_version integer NOT NULL CHECK (generation_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(world_id, region_x, region_y),
  UNIQUE(world_id, region_id)
);

-- Version-1 used one 32x32 generation everywhere. Persist those addresses before
-- attaching claims so later generator upgrades cannot reinterpret old land.
INSERT INTO world_regions(
  world_id, region_x, region_y, region_id, size, generation_version, created_at
)
SELECT DISTINCT
  world_id,
  floor(x / 32.0)::integer AS region_x,
  floor(y / 32.0)::integer AS region_y,
  world_id || '|g1|r' || floor(x / 32.0)::integer || ',' || floor(y / 32.0)::integer || '|s32',
  32,
  1,
  MIN(assigned_at) OVER (
    PARTITION BY world_id, floor(x / 32.0)::integer, floor(y / 32.0)::integer
  )
FROM world_plots;

ALTER TABLE world_plots
  ADD COLUMN region_id text,
  ADD COLUMN lease_id text,
  ADD COLUMN lease_issued_at timestamptz,
  ADD COLUMN lease_renewed_at timestamptz;

UPDATE world_plots plot SET region_id = region.region_id
FROM world_regions region
WHERE region.world_id = plot.world_id
  AND region.region_x = floor(plot.x / 32.0)::integer
  AND region.region_y = floor(plot.y / 32.0)::integer;

-- A legacy nullable deadline meant "guest" but did not identify the lease or
-- distinguish issue/renewal. Give every extant guest a stable fencing identity.
UPDATE world_plots SET
  lease_id = 'legacy:' || md5(player_id),
  lease_issued_at = LEAST(assigned_at, lease_expires_at - interval '1 millisecond'),
  lease_renewed_at = LEAST(assigned_at, lease_expires_at - interval '1 millisecond')
WHERE lease_expires_at IS NOT NULL;

ALTER TABLE world_plots
  ALTER COLUMN region_id SET NOT NULL,
  ADD CONSTRAINT world_plots_region_fk
    FOREIGN KEY(world_id, region_id) REFERENCES world_regions(world_id, region_id),
  ADD CONSTRAINT world_plots_guest_lease_consistent CHECK (
    (lease_id IS NULL AND lease_issued_at IS NULL AND lease_renewed_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_id IS NOT NULL AND length(lease_id) BETWEEN 1 AND 256
      AND lease_issued_at IS NOT NULL AND lease_renewed_at IS NOT NULL AND lease_expires_at IS NOT NULL
      AND lease_issued_at <= lease_renewed_at AND lease_renewed_at < lease_expires_at)
  );
CREATE INDEX world_plots_region_id_idx ON world_plots(world_id, region_id);
CREATE UNIQUE INDEX world_plots_lease_id_idx ON world_plots(lease_id) WHERE lease_id IS NOT NULL;

CREATE TABLE world_allocation_state (
  world_id text PRIMARY KEY REFERENCES world_realms(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  region_size integer NOT NULL CHECK (region_size BETWEEN 1 AND 1024),
  current_generation_version integer NOT NULL CHECK (current_generation_version > 0),
  next_ordinal bigint NOT NULL CHECK (next_ordinal BETWEEN 0 AND 4000004000001),
  revision bigint NOT NULL CHECK (revision >= 0),
  updated_at timestamptz NOT NULL
);

-- Preserve the high-water mark for an already-populated v2 database. Fresh
-- databases and frozen JSON imports start at zero and the importer advances it.
WITH plot_radii AS (
  SELECT world_id, x::bigint AS x, y::bigint AS y,
    GREATEST(abs(x::bigint), abs(y::bigint)) AS radius
  FROM world_plots
), plot_ordinals AS (
  SELECT world_id,
    CASE WHEN radius = 0 THEN 0::bigint ELSE
      (2 * radius - 1) * (2 * radius - 1)
      + CASE
        WHEN x = -radius THEN y + radius
        WHEN x = radius THEN (2 * radius + 1) + (4 * radius - 2) + y + radius
        ELSE (2 * radius + 1) + (x + radius - 1) * 2
          + CASE WHEN y = -radius THEN 0 ELSE 1 END
      END
    END AS ordinal
  FROM plot_radii
), high_water AS (
  SELECT world_id, MAX(ordinal) + 1 AS next_ordinal FROM plot_ordinals GROUP BY world_id
)
INSERT INTO world_allocation_state(
  world_id, schema_version, region_size, current_generation_version,
  next_ordinal, revision, updated_at
)
SELECT realm.id, 1, 32, realm.generator_version,
  COALESCE(high_water.next_ordinal, 0), 0, NOW()
FROM world_realms realm
LEFT JOIN high_water ON high_water.world_id = realm.id;

CREATE TABLE world_released_slots (
  world_id text NOT NULL REFERENCES world_realms(id),
  ordinal bigint NOT NULL CHECK (ordinal BETWEEN 0 AND 4000004000000),
  plot_version bigint NOT NULL CHECK (plot_version BETWEEN 1 AND 9007199254740991),
  released_at timestamptz NOT NULL,
  PRIMARY KEY(world_id, ordinal)
);
CREATE INDEX world_released_slots_age_idx ON world_released_slots(world_id, released_at, ordinal);
`

const VILLAGE_APPEARANCE_REVISION_SQL = String.raw`
ALTER TABLE villages ADD COLUMN appearance_revision bigint;
UPDATE villages SET appearance_revision = layout_revision;
ALTER TABLE villages
  ALTER COLUMN appearance_revision SET NOT NULL,
  ADD CONSTRAINT villages_appearance_revision_non_negative CHECK (appearance_revision >= 0);
`

const BOUNDED_QUERY_PATHS_SQL = String.raw`
-- Top-N and nearest-trophy discovery both stop within this ordered index.
CREATE INDEX player_profiles_trophy_discovery_idx
  ON player_profiles(trophies DESC, player_id ASC)
  INCLUDE (username, shield_until, last_seen_at, revision);

-- Atlas windows are range-bounded on y/x and return in the same order.
CREATE INDEX world_plots_atlas_window_idx
  ON world_plots(world_id, y, x, player_id);

-- Preparing attacks do not own the defender lease, but remain visible as
-- bounded incoming work. The existing unique lease index handles engagement.
CREATE INDEX attacks_active_incoming_idx
  ON attacks(defender_id, created_at DESC, id DESC)
  WHERE target_kind = 'player'
    AND state IN ('preparing', 'engaged', 'active', 'finalizing');

CREATE INDEX notifications_history_page_idx
  ON notifications(player_id, occurred_at DESC, id DESC);
CREATE INDEX notifications_unread_page_idx
  ON notifications(player_id, occurred_at DESC, id DESC)
  WHERE read_at IS NULL;
`

const ATTACK_AGGREGATE_AUTHORITY_SQL = String.raw`
ALTER TABLE attack_commands RENAME COLUMN request_id TO command_id;
ALTER TABLE attacks ADD COLUMN authority jsonb;

-- Old terminal imports have no reconstructable command/event authority and
-- remain NULL. Every resumable attack stores one complete schema-v1 aggregate;
-- the relational columns are a checked query/index projection of that JSON.
ALTER TABLE attacks ADD CONSTRAINT attacks_authority_projection_consistent CHECK (
  (authority IS NULL AND state IN ('settled', 'cancelled', 'expired')) OR (
    authority IS NOT NULL
    AND
    jsonb_typeof(authority) = 'object'
    AND authority->>'schemaVersion' = '1'
    AND authority->>'attackId' = id
    AND authority->>'attackerId' = attacker_id
    AND lower(authority->>'phase') = state
    AND authority->>'version' = state_version::text
    AND lower(authority#>>'{target,kind}') = target_kind
    AND authority#>>'{target,targetId}' = target_id
    AND authority#>>'{target,plot,worldId}' = world_id
    AND authority#>>'{target,plot,x}' = target_x::text
    AND authority#>>'{target,plot,y}' = target_y::text
    AND authority#>>'{rules,simulationVersion}' = simulation_version::text
    AND jsonb_typeof(authority->'events') = 'array'
    AND jsonb_typeof(authority->'commandReceipts') = 'object'
  )
);
COMMENT ON COLUMN attacks.authority IS
  'Complete schema-v1 AttackAggregate; NULL only for immutable pre-aggregate history';

-- Bitmap-OR friendly indexes for one atlas/map participant batch. The result
-- is still hard-capped by the repository.
CREATE INDEX attacks_active_participant_attacker_idx
  ON attacks(attacker_id, created_at DESC, id DESC)
  WHERE state IN ('preparing', 'engaged', 'active', 'finalizing');
CREATE INDEX attacks_active_participant_defender_idx
  ON attacks(defender_id, created_at DESC, id DESC)
  WHERE defender_id IS NOT NULL
    AND state IN ('preparing', 'engaged', 'active', 'finalizing');
`

const RUNTIME_MAINTENANCE_SQL = String.raw`
CREATE INDEX balance_ledger_economy_days_idx
  ON balance_ledger(created_at, operation, currency);
CREATE INDEX player_profiles_active_shield_idx
  ON player_profiles(shield_until, player_id)
  WHERE shield_until IS NOT NULL;
`

const BOUNDED_PRESENTATION_REPLAYS_SQL = String.raw`
-- Compact command/settlement authority remains durable elsewhere. Only
-- disposable visual samples are charged to this atomic per-attack counter.
CREATE TABLE replay_presentation_usage (
  attack_id text PRIMARY KEY REFERENCES attacks(id) ON DELETE CASCADE,
  bytes_used bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  updated_at timestamptz NOT NULL
);

CREATE INDEX attacks_terminal_replay_retention_idx
  ON attacks(ended_at, id)
  WHERE ended_at IS NOT NULL;
CREATE INDEX replay_chunks_presentation_retention_idx
  ON replay_chunks(attack_id, sequence)
  WHERE format = 'presentation-frame-v1';
`

const BOUNDED_AUXILIARY_RETENTION_SQL = String.raw`
-- Match the legacy/UI contract: only the newest 50 notifications per player
-- are authoritative. Repository writers serialize on player_profiles before
-- maintaining this cap; this one-time cleanup normalizes upgraded databases.
WITH ranked_notifications AS MATERIALIZED (
  SELECT player_id, id,
    row_number() OVER (
      PARTITION BY player_id ORDER BY occurred_at DESC, id DESC
    ) AS retention_rank
  FROM notifications
)
DELETE FROM notifications notification
USING ranked_notifications ranked
WHERE notification.player_id = ranked.player_id
  AND notification.id = ranked.id
  AND ranked.retention_rank > 50;

-- Outbox rows are best-effort integration hints, not game authority. Runtime
-- maintenance keeps a finite delivery window and never deletes a live lease.
CREATE INDEX outbox_published_retention_idx
  ON outbox_events(published_at, id)
  WHERE published_at IS NOT NULL;
CREATE INDEX outbox_unpublished_retention_idx
  ON outbox_events(created_at, id)
  WHERE published_at IS NULL;

CREATE INDEX operation_markers_retention_idx
  ON operation_markers(observed_at, player_id, kind, marker_key);
`

const WORLD_ALLOCATION_CONCURRENCY_SQL = String.raw`
-- Claims and released ordinals are mutually exclusive. Earlier runtime builds
-- serialized both operations on the allocation cursor, so this is normally a
-- no-op; it also repairs hand-edited/corrupt upgrades before lock-free release.
WITH occupied_ordinals AS MATERIALIZED (
  SELECT plot.world_id,
    CASE WHEN GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) = 0 THEN 0::bigint ELSE
      (2 * GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) - 1)
        * (2 * GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) - 1)
      + CASE
        WHEN plot.x::bigint = -GREATEST(abs(plot.x::bigint), abs(plot.y::bigint))
          THEN plot.y::bigint + GREATEST(abs(plot.x::bigint), abs(plot.y::bigint))
        WHEN plot.x::bigint = GREATEST(abs(plot.x::bigint), abs(plot.y::bigint))
          THEN (2 * GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) + 1)
            + (4 * GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) - 2)
            + plot.y::bigint + GREATEST(abs(plot.x::bigint), abs(plot.y::bigint))
        ELSE (2 * GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) + 1)
          + (plot.x::bigint + GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) - 1) * 2
          + CASE
              WHEN plot.y::bigint = -GREATEST(abs(plot.x::bigint), abs(plot.y::bigint)) THEN 0
              ELSE 1
            END
      END
    END AS ordinal
  FROM world_plots plot
)
DELETE FROM world_released_slots released
USING occupied_ordinals occupied
WHERE released.world_id = occupied.world_id
  AND released.ordinal = occupied.ordinal;

CREATE INDEX world_plots_guest_reaper_idx
  ON world_plots(world_id, lease_expires_at, player_id)
  WHERE lease_expires_at IS NOT NULL;
`

// The spiral settlement model makes bot-classified ordinals settleable, so the
// world center fills with real accounts. The column marks whether a world's
// pre-spiral holes were indexed as free slots; hydrology-aware eligibility
// cannot run in SQL, so the bounded backfill itself happens in the runtime
// (world-authority) the first time the allocation row is locked at model 1.
const SPIRAL_CENTER_ALLOCATION_SQL = String.raw`
ALTER TABLE world_allocation_state
  ADD COLUMN allocation_model integer NOT NULL DEFAULT 1
  CHECK (allocation_model >= 1);
`

const VILLAGE_BANNER_SQL = String.raw`
ALTER TABLE villages
  ADD COLUMN banner jsonb,
  ADD CONSTRAINT villages_banner_object CHECK (banner IS NULL OR jsonb_typeof(banner) = 'object');
`

const PERSISTENT_BOT_VILLAGES_SQL = String.raw`
CREATE TABLE bot_villages (
  id text PRIMARY KEY,
  world_id text NOT NULL REFERENCES world_realms(id),
  x integer NOT NULL,
  y integer NOT NULL,
  plot_version bigint NOT NULL CHECK (plot_version > 0),
  world_generation_version integer NOT NULL CHECK (world_generation_version > 0),
  generator_version integer NOT NULL CHECK (generator_version > 0),
  seed bigint NOT NULL CHECK (seed > 0 AND seed <= 9007199254740991),
  username text NOT NULL CHECK (length(trim(username)) > 0),
  trophies integer NOT NULL CHECK (trophies >= 0),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  world jsonb NOT NULL CHECK (jsonb_typeof(world) = 'object'),
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  UNIQUE(world_id, x, y),
  CONSTRAINT bot_village_world_identity CHECK (
    world ? 'id'
    AND world ? 'ownerId'
    AND world ? 'buildings'
    AND world ? 'resources'
    AND world ->> 'id' = id
    AND world ->> 'ownerId' = id
    AND jsonb_typeof(world -> 'buildings') = 'array'
    AND jsonb_typeof(world -> 'resources') = 'object'
  )
);

CREATE INDEX bot_villages_window_idx
  ON bot_villages(world_id, y, x, id);
`

const ADMIN_AUTHORITY_SQL = String.raw`
CREATE TABLE account_moderation (
  player_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  access_state text NOT NULL CHECK (access_state IN ('active', 'suspended', 'banned')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  access_until timestamptz,
  updated_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  CONSTRAINT account_moderation_until_consistent CHECK (
    access_state = 'suspended' OR access_until IS NULL
  )
);
CREATE INDEX account_moderation_blocked_idx
  ON account_moderation(access_state, access_until, player_id)
  WHERE access_state <> 'active';

CREATE TABLE admin_runtime_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  maintenance_enabled boolean NOT NULL,
  maintenance_message text CHECK (maintenance_message IS NULL OR length(maintenance_message) <= 500),
  updated_at timestamptz NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0)
);
INSERT INTO admin_runtime_config(
  singleton, maintenance_enabled, maintenance_message, updated_at, revision
) VALUES (true, false, NULL, NOW(), 1);

CREATE TABLE admin_audit_log (
  id text PRIMARY KEY,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (target_type IN ('player', 'system')),
  target_id text,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT admin_audit_target_consistent CHECK (
    (target_type = 'player' AND target_id IS NOT NULL)
    OR (target_type = 'system' AND target_id IS NULL)
  )
);
CREATE INDEX admin_audit_history_idx ON admin_audit_log(occurred_at DESC, id DESC);

CREATE FUNCTION reject_admin_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;
CREATE TRIGGER admin_audit_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();
`

const BOT_REVISION_EPOCH_SQL = String.raw`
ALTER TABLE world_allocation_state
  ADD COLUMN bot_revision_epoch bigint NOT NULL DEFAULT 1
  CHECK (bot_revision_epoch > 0);
`

const ADMIN_STARTER_VILLAGE_SQL = String.raw`
ALTER TABLE admin_runtime_config
  ADD COLUMN starter_village jsonb;

ALTER TABLE admin_runtime_config
  ADD CONSTRAINT admin_runtime_config_starter_village_object CHECK (
    starter_village IS NULL OR (
      jsonb_typeof(starter_village) = 'object'
      AND jsonb_typeof(starter_village->'resources') = 'object'
      AND jsonb_typeof(starter_village->'buildings') = 'array'
      AND jsonb_typeof(starter_village->'wallLevel') = 'number'
    )
  );
`

const ADMIN_TEST_MODE_SQL = String.raw`
ALTER TABLE admin_runtime_config
  ADD COLUMN test_mode_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN test_mode_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE admin_runtime_config
  ADD CONSTRAINT admin_runtime_config_test_mode_overrides_object CHECK (
    jsonb_typeof(test_mode_overrides) = 'object'
  );
`

const ACCOUNT_ONBOARDING_AND_TEST_MODE_ANNOUNCEMENTS_SQL = String.raw`
ALTER TABLE admin_runtime_config
  ADD COLUMN test_mode_global_activation_id text,
  ADD COLUMN test_mode_player_activation_ids jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE admin_runtime_config AS config
SET test_mode_global_activation_id = CASE
      WHEN test_mode_enabled THEN 'tm.g.legacy.' || revision::text
      ELSE NULL
    END,
    test_mode_player_activation_ids = CASE
      WHEN test_mode_enabled THEN '{}'::jsonb
      ELSE COALESCE((
        SELECT jsonb_object_agg(
          entry.key,
          to_jsonb('tm.p.legacy.' || config.revision::text || '.' || entry.key)
        )
        FROM jsonb_each(config.test_mode_overrides) AS entry
        WHERE entry.value = 'true'::jsonb
      ), '{}'::jsonb)
    END;

ALTER TABLE admin_runtime_config
  ADD CONSTRAINT admin_runtime_config_test_mode_global_activation_id CHECK (
    test_mode_global_activation_id IS NULL
    OR length(test_mode_global_activation_id) BETWEEN 1 AND 160
  ),
  ADD CONSTRAINT admin_runtime_config_test_mode_player_activation_ids_object CHECK (
    jsonb_typeof(test_mode_player_activation_ids) = 'object'
  );

ALTER TABLE accounts
  ADD COLUMN test_mode_acknowledged_activation_id text,
  ADD COLUMN intro_battle_completed boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT accounts_test_mode_acknowledged_activation_id CHECK (
    test_mode_acknowledged_activation_id IS NULL
    OR length(test_mode_acknowledged_activation_id) BETWEEN 1 AND 160
  );
`

const WATCHTOWER_PLACEMENT_ONBOARDING_SQL = String.raw`
ALTER TABLE accounts
  ADD COLUMN watchtower_placement_completed boolean NOT NULL DEFAULT true;
`

const REPLAY_V2_PRESENTATION_INDEX_SQL = String.raw`
DROP INDEX IF EXISTS replay_chunks_presentation_retention_idx;
CREATE INDEX replay_chunks_presentation_retention_idx
  ON replay_chunks(attack_id, sequence)
  WHERE format LIKE 'presentation-%';
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core_authority', sql: CORE_SQL },
  { version: 2, name: 'battle_authority', sql: BATTLES_SQL },
  { version: 3, name: 'expandable_world_authority', sql: EXPANDABLE_WORLD_SQL },
  { version: 4, name: 'village_appearance_revision', sql: VILLAGE_APPEARANCE_REVISION_SQL },
  { version: 5, name: 'bounded_query_paths', sql: BOUNDED_QUERY_PATHS_SQL },
  { version: 6, name: 'attack_aggregate_authority', sql: ATTACK_AGGREGATE_AUTHORITY_SQL },
  { version: 7, name: 'runtime_maintenance_queries', sql: RUNTIME_MAINTENANCE_SQL },
  { version: 8, name: 'bounded_presentation_replays', sql: BOUNDED_PRESENTATION_REPLAYS_SQL },
  { version: 9, name: 'bounded_auxiliary_retention', sql: BOUNDED_AUXILIARY_RETENTION_SQL },
  { version: 10, name: 'world_allocation_concurrency', sql: WORLD_ALLOCATION_CONCURRENCY_SQL },
  { version: 11, name: 'spiral_center_allocation', sql: SPIRAL_CENTER_ALLOCATION_SQL },
  { version: 12, name: 'village_banner', sql: VILLAGE_BANNER_SQL },
  { version: 13, name: 'persistent_bot_villages', sql: PERSISTENT_BOT_VILLAGES_SQL },
  { version: 14, name: 'admin_authority', sql: ADMIN_AUTHORITY_SQL },
  { version: 15, name: 'bot_revision_epoch', sql: BOT_REVISION_EPOCH_SQL },
  { version: 16, name: 'admin_starter_village', sql: ADMIN_STARTER_VILLAGE_SQL },
  { version: 17, name: 'admin_test_mode', sql: ADMIN_TEST_MODE_SQL },
  {
    version: 18,
    name: 'account_onboarding_and_test_mode_announcements',
    sql: ACCOUNT_ONBOARDING_AND_TEST_MODE_ANNOUNCEMENTS_SQL
  },
  { version: 19, name: 'watchtower_placement_onboarding', sql: WATCHTOWER_PLACEMENT_ONBOARDING_SQL },
  { version: 20, name: 'replay_v2_presentation_index', sql: REPLAY_V2_PRESENTATION_INDEX_SQL }
]

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

/** Apply every pending migration under one database-wide advisory lock. */
export async function migrate(database: SqlDatabase): Promise<void> {
  await database.withTransaction(async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock($1)', [738_104_221])
    await transaction.query(String.raw`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )
    `)
    const applied = await transaction.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    )
    const byVersion = new Map(applied.rows.map(row => [row.version, row]))
    for (const migration of MIGRATIONS) {
      const digest = checksum(migration.sql)
      const previous = byVersion.get(migration.version)
      if (previous) {
        if (previous.name !== migration.name || previous.checksum !== digest) {
          throw new Error(`Migration ${migration.version} was modified after being applied`)
        }
        continue
      }
      await transaction.query(migration.sql)
      await transaction.query(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES ($1, $2, $3, NOW())',
        [migration.version, migration.name, digest]
      )
    }
  }, { isolation: 'serializable', maxRetries: 0 })
}
