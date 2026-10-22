-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
DECLARE
  v_table text;
  v_cmd text;
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL')
      AND (roles && ARRAY['public', 'anon']::name[])
      AND (qual LIKE '%avatars%' OR qual LIKE '%flow-media%' OR qual LIKE '%chat-media%')
  ) THEN
    RAISE EXCEPTION
      'a storage SELECT policy on avatars/flow-media/chat-media still applies to anon — migration 043 did not apply';
  END IF;
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
      AND policyname IN (
        'Users can read their own avatar',
        'Members can read flow media',
        'Members can read chat media'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'the scoped storage SELECT policies are missing — migration 043 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'public._bcast_bump(uuid,text,integer)',
      'public.recompute_broadcast_counts(uuid)',
      'public.claim_ai_reply_slot(uuid,integer)',
      'public.record_webhook_failure(uuid,integer)',
      'public.merge_duplicate_contacts()',
      'public.merge_duplicate_conversations()'
    ]::regprocedure[]) AS f(fn)
    WHERE has_function_privilege('anon', f.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', f.fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f.fn, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'an internal SECURITY DEFINER function is still executable by anon/authenticated — migration 044 did not apply';
  END IF;

  -- 045 widens the automation_pending_executions status CHECK. It is a
  -- DROP + ADD by name, so a wrong constraint name would leave the old
  -- CHECK in place and every "wait for reply" park would be rejected at
  -- runtime, not at migration time.
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint
        WHERE conname = 'automation_pending_executions_status_check')
     ) NOT LIKE '%awaiting_reply%' THEN
    RAISE EXCEPTION
      'automation_pending_executions_status_check does not allow awaiting_reply — migration 045 did not apply';
  END IF;
  IF to_regclass('public.idx_automation_pending_awaiting_reply') IS NULL THEN
    RAISE EXCEPTION
      'idx_automation_pending_awaiting_reply is missing — migration 045 did not apply';
  END IF;

  -- 047 installs accounts.vertical_key and the booking_* schema. The
  -- load-bearing bit is the double-booking guard: if the EXCLUDE
  -- constraint silently no-ops (typo'd name/opclass), two customers can
  -- hold the same barber at the same time and nothing else notices.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'vertical_key'
  ) THEN
    RAISE EXCEPTION
      'accounts.vertical_key is missing — migration 047 did not apply';
  END IF;

  IF to_regclass('public.booking_appointments') IS NULL
     OR to_regclass('public.booking_sessions') IS NULL
     OR to_regclass('public.booking_events') IS NULL THEN
    RAISE EXCEPTION
      'booking_* tables are missing — migration 047 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_appointments_no_overlap'
      AND conrelid = 'public.booking_appointments'::regclass
      AND contype = 'x'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments_no_overlap is missing — migration 047 did not apply';
  END IF;

  -- The partial unique index behind "one active booking session per
  -- (account, contact)" — the dispatcher's single-row lookup contract
  -- for the Phase 2 booking controller. Dropping the WHERE clause (or
  -- the UNIQUE) would silently allow two live sessions and the bot
  -- would lose track of which dialog it is driving.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_sessions'
      AND indexname = 'idx_booking_sessions_one_active'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND indexdef LIKE '%WHERE%'
  ) THEN
    RAISE EXCEPTION
      'idx_booking_sessions_one_active is missing or not partial-unique — migration 047 did not apply';
  END IF;

  IF NOT has_function_privilege(
       'service_role', 'public.log_booking_appointment_event()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.log_booking_appointment_event()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.log_booking_appointment_event()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'log_booking_appointment_event grants are wrong — migration 047 did not apply';
  END IF;

  -- Phase 3 (048): the reminder runner claims each signal with a
  -- conditional UPDATE over these columns, so their absence (or a
  -- non-partial due index) breaks idempotency rather than the send.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name = 'reminder_2h_sent_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments.reminder_2h_sent_at is missing — migration 048 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_appointments'
      AND indexname = 'idx_booking_appointments_due_reminder_2h'
      AND indexdef LIKE '%WHERE%'
  ) THEN
    RAISE EXCEPTION
      'idx_booking_appointments_due_reminder_2h is missing or not partial — migration 048 did not apply';
  END IF;

  -- `booking_settings` defaults the optional 2 h signal to OFF: the
  -- product decision is "24 h always, 2 h on purpose". A flipped
  -- default would start sending an extra message to every account.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_settings'
      AND column_name = 'reminders_2h_enabled'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION
      'booking_settings.reminders_2h_enabled is missing or not default-false — migration 048 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass('public.booking_settings')
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION
      'booking_settings RLS is not enabled — migration 048 did not apply';
  END IF;

  -- Phase 4 (049): the config page saves address + bot texts here. A
  -- missing `bot_texts` column (or one that can be NULL / hold an array)
  -- would only surface at runtime, when the bot merges overrides.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_settings'
      AND column_name = 'bot_texts'
      AND data_type = 'jsonb'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'booking_settings.bot_texts is missing or nullable — migration 049 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_settings'
      AND column_name = 'address'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION
      'booking_settings.address is missing — migration 049 did not apply';
  END IF;

  -- The object CHECK is the guard that keeps booleans/arrays/strings
  -- out: the merge code assumes `Record<string, string>`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'booking_settings_bot_texts_object_check'
      AND conrelid = 'public.booking_settings'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'booking_settings_bot_texts_object_check is missing — migration 049 did not apply';
  END IF;

  -- 050 (D2): configuration writes are owner/admin only. Every write
  -- policy on the six config tables must exist AND gate on 'admin' —
  -- a policy left at 'agent' (or dropped and not recreated) re-opens
  -- direct PostgREST edits for agents.
  FOR v_table IN SELECT unnest(ARRAY[
    'booking_services', 'booking_staff', 'booking_staff_services',
    'booking_working_hours', 'booking_time_off', 'booking_settings'
  ]) LOOP
    FOR v_cmd IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table
          AND cmd = v_cmd
          AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''admin''%'
          AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%''agent''%'
      ) THEN
        RAISE EXCEPTION
          '% % policy is missing or not admin-only — migration 050 did not apply',
          v_table, v_cmd;
      END IF;
    END LOOP;
    -- Reads stay open to every member (viewer included).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd = 'SELECT'
        AND coalesce(qual, '') NOT LIKE '%''admin''%'
        AND coalesce(qual, '') NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% SELECT policy is missing or no longer open to every member', v_table;
    END IF;
  END LOOP;

  -- …while operational tables keep agent writes (the agenda moves
  -- appointments; the bot's sessions are agent-writable too).
  FOR v_table IN SELECT unnest(ARRAY['booking_appointments', 'booking_sessions']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd = 'UPDATE'
        AND coalesce(qual, '') LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% UPDATE policy no longer allows agents — 050 must not touch operational tables',
        v_table;
    END IF;
  END LOOP;

  -- 050 (D3): owner_user_id / vertical_key are guarded by a BEFORE
  -- UPDATE trigger on accounts (034's pattern for profiles).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.accounts'::regclass
      AND tgname = 'enforce_account_protected_columns'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION
      'enforce_account_protected_columns trigger is missing on accounts — migration 050 did not apply';
  END IF;

  -- 051: agenda armable. The new settings columns are read by the bot
  -- on every message through a typed select, and `answers` is written
  -- on every booking: a column that silently failed to add is a runtime
  -- PostgREST error, not a migration error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_settings'
      AND (
        (column_name = 'preset_key' AND data_type = 'text')
        OR (column_name = 'labels' AND data_type = 'jsonb' AND is_nullable = 'NO')
        OR (column_name IN (
              'choose_staff', 'show_price', 'show_duration',
              'reminders_enabled', 'allow_reschedule'
            )
            AND data_type = 'boolean' AND is_nullable = 'NO'
            AND column_default = 'true')
      )
  ) <> 7 THEN
    RAISE EXCEPTION
      'booking_settings agenda columns are missing or have wrong defaults — migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name = 'answers'
      AND data_type = 'jsonb'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments.answers is missing or nullable — migration 051 did not apply';
  END IF;

  -- Each lookup is scoped to its table (conrelid) so a same-named
  -- constraint elsewhere cannot satisfy it.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE contype = 'c'
      AND (
        (conrelid = 'public.booking_settings'::regclass AND conname IN (
          'booking_settings_labels_object_check',
          'booking_settings_preset_key_check'
        ))
        OR (conrelid = 'public.booking_appointments'::regclass AND conname IN (
          'booking_appointments_answers_object_check',
          'booking_appointments_answers_size_check'
        ))
      )
  ) <> 4 THEN
    RAISE EXCEPTION
      'booking_settings/booking_appointments CHECK constraints are missing — migration 051 did not apply';
  END IF;

  IF to_regclass('public.booking_questions') IS NULL THEN
    RAISE EXCEPTION 'booking_questions is missing — migration 051 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'public.booking_questions'::regclass
      AND conname IN (
        'booking_questions_position_check',
        'booking_questions_options_max_check',
        'booking_questions_opcion_options_check'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'booking_questions CHECK constraints are missing — migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass('public.booking_questions')
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION
      'booking_questions RLS is not enabled — migration 051 did not apply';
  END IF;

  -- Same RLS shape as the 050 config tables: writes owner/admin only,
  -- reads open to every member.
  FOR v_cmd IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'booking_questions'
        AND cmd = v_cmd
        AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''admin''%'
        AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        'booking_questions % policy is missing or not admin-only — migration 051 did not apply',
        v_cmd;
    END IF;
  END LOOP;
  -- No write policy on booking_questions may mention 'agent' at all
  -- (the loop above only proves one admin policy exists per command).
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'booking_questions'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
      AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''agent''%'
  ) THEN
    RAISE EXCEPTION
      'a booking_questions write policy mentions agent — migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'booking_questions'
      AND cmd = 'SELECT'
      AND coalesce(qual, '') NOT LIKE '%''admin''%'
      AND coalesce(qual, '') NOT LIKE '%''agent''%'
  ) THEN
    RAISE EXCEPTION
      'booking_questions SELECT policy is missing or no longer open to every member — migration 051 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.booking_questions'::regclass
      AND tgname = 'set_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'booking_questions set_updated_at trigger is missing — migration 051 did not apply';
  END IF;

  -- 052: the data rewrite — no account may keep the legacy key once
  -- 052 ran. Only meaningful when this file runs against PRODUCTION
  -- after 052 has been applied (and after the code deploy): the CI
  -- database has no accounts, so there it passes trivially.
  IF EXISTS (SELECT 1 FROM accounts WHERE vertical_key = 'barberia') THEN
    RAISE EXCEPTION
      'an account still has vertical_key = barberia — migration 052 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
