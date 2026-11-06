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
  -- direct PostgREST edits for agents. 055 adds clinic_settings and
  -- clinic_locations to the same rule.
  FOR v_table IN SELECT unnest(ARRAY[
    'booking_services', 'booking_staff', 'booking_staff_services',
    'booking_working_hours', 'booking_time_off', 'booking_settings',
    'clinic_settings', 'clinic_locations'
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
    -- The EXISTS above finds ONE admin policy; a second, permissive
    -- policy (or a FOR ALL, which reports as cmd = 'ALL') would still
    -- let agents write. No write policy on these tables may mention
    -- 'agent' at all.
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% has a write policy that still allows agents — migration 050 did not apply',
        v_table;
    END IF;
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
  -- UPDATE trigger on accounts (034's pattern for profiles). The
  -- function must stay SECURITY INVOKER — that is what makes
  -- `current_user` the writer — and the trigger enabled for normal
  -- writes ('O') or always ('A'); 'D'/'R' would let the guard sleep.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.accounts'::regclass
      AND t.tgname = 'enforce_account_protected_columns'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'enforce_account_protected_columns trigger is missing, disabled, or SECURITY DEFINER — migration 050 did not apply';
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

  -- 053: combinable account modules. A column or constraint that
  -- silently failed to add would only surface at runtime (every account
  -- read selects `modules`), and the trigger must keep the client away
  -- from it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name = 'modules' AND data_type = 'ARRAY' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'accounts.modules (text[] NOT NULL) is missing — migration 053 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounts'::regclass
      AND conname = 'accounts_modules_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'accounts_modules_check constraint is missing — migration 053 did not apply';
  END IF;

  IF to_regprocedure('public.valid_module_keys(text[])') IS NULL THEN
    RAISE EXCEPTION
      'public.valid_module_keys(text[]) is missing — migration 053 did not apply';
  END IF;

  IF NOT public.valid_module_keys(ARRAY['agenda', 'ventas'])
     OR public.valid_module_keys(ARRAY['Ventas'])
     OR public.valid_module_keys(ARRAY['con espacio'])
     OR NOT public.valid_module_keys(ARRAY[]::text[])
  THEN
    RAISE EXCEPTION
      'valid_module_keys does not enforce the module key shape — migration 053 did not apply';
  END IF;

  -- bool_and ignores NULLs, so a NULL element would slip through a naive
  -- check: the function must reject it explicitly.
  IF public.valid_module_keys(ARRAY[NULL]::text[]) IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      'valid_module_keys accepts a NULL element — migration 053 did not apply';
  END IF;

  IF pg_get_functiondef('public.enforce_account_protected_columns()'::regprocedure)
       NOT LIKE '%NEW.modules IS DISTINCT FROM OLD.modules%'
  THEN
    RAISE EXCEPTION
      'enforce_account_protected_columns does not protect accounts.modules — migration 053 did not apply';
  END IF;

  -- 053: vertical_key → modules sync. The trigger must exist, run as the
  -- invoker, and sort BEFORE the 050 protected-columns guard (BEFORE
  -- triggers fire in name order) so the guard sees the filled modules.
  IF to_regprocedure('public.sync_account_modules_from_vertical()') IS NULL THEN
    RAISE EXCEPTION
      'public.sync_account_modules_from_vertical() is missing — migration 053 did not apply';
  END IF;

  IF (SELECT prosecdef FROM pg_proc
      WHERE oid = to_regprocedure('public.sync_account_modules_from_vertical()'))
  THEN
    RAISE EXCEPTION
      'sync_account_modules_from_vertical is SECURITY DEFINER — it must run as the invoker';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.accounts'::regclass
      AND tgname = 'accounts_sync_modules'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'trigger accounts_sync_modules is missing on accounts — migration 053 did not apply';
  END IF;

  -- Compare the real trigger names on accounts, byte order (COLLATE "C"),
  -- the order Postgres fires BEFORE triggers in. NULL (one missing) fails.
  IF (
    SELECT bool_or(s.tgname COLLATE "C" >= g.tgname COLLATE "C")
    FROM pg_trigger s, pg_trigger g
    WHERE s.tgrelid = 'public.accounts'::regclass
      AND g.tgrelid = 'public.accounts'::regclass
      AND s.tgname = 'accounts_sync_modules'
      AND g.tgname = 'enforce_account_protected_columns'
      AND NOT s.tgisinternal
      AND NOT g.tgisinternal
  ) IS NOT FALSE THEN
    RAISE EXCEPTION
      'accounts_sync_modules must fire before enforce_account_protected_columns (or one of them is missing)';
  END IF;

  -- 053: the backfill — an agenda account must list the agenda in
  -- modules. Like the 052 check, only meaningful against PRODUCTION
  -- after 053 ran (the CI database has no accounts).
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE vertical_key IN ('agenda', 'barberia')
      AND NOT ('agenda' = ANY(modules))
  ) THEN
    RAISE EXCEPTION
      'an agenda account has no agenda in modules — migration 053 did not apply';
  END IF;

  -- 054: a cancelled order is final for payment too (ledger guard).
  IF to_regprocedure('public.orders_ledger_guard()') IS NULL
     OR pg_get_functiondef('public.orders_ledger_guard()'::regprocedure)
       NOT LIKE '%OLD.status = ''cancelled'' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status%'
  THEN
    RAISE EXCEPTION
      'orders_ledger_guard lets a cancelled order change its payment — migration 054 did not apply';
  END IF;

  -- 054: Ventas A. Same failure mode as every migration here: a typo'd
  -- object name under IF NOT EXISTS is a green no-op. Orders are the
  -- sales ledger, so the "nobody deletes" and "totals add up" rules are
  -- asserted explicitly.
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'public.orders is missing — migration 054 did not apply';
  END IF;
  IF to_regclass('public.order_items') IS NULL THEN
    RAISE EXCEPTION 'public.order_items is missing — migration 054 did not apply';
  END IF;
  IF to_regclass('public.sales_settings') IS NULL THEN
    RAISE EXCEPTION 'public.sales_settings is missing — migration 054 did not apply';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['orders', 'order_items', 'sales_settings'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = to_regclass('public.' || v_table)
        AND relrowsecurity
    ) THEN
      RAISE EXCEPTION '% RLS is not enabled — migration 054 did not apply', v_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd = 'SELECT'
        AND coalesce(qual, '') NOT LIKE '%''admin''%'
        AND coalesce(qual, '') NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% SELECT policy is missing or no longer open to every member — migration 054 did not apply',
        v_table;
    END IF;
  END LOOP;

  -- Nobody deletes an order or its lines through the API: they are
  -- cancelled. Neither a DELETE policy nor a catch-all (ALL) may exist.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('orders', 'order_items')
      AND cmd IN ('DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION
      'orders/order_items have a DELETE or ALL policy — migration 054 did not apply';
  END IF;

  -- New orders and lines are born ONLY in create_order(): no INSERT
  -- policy on either table, and no UPDATE policy on the lines.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('orders', 'order_items')
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION
      'orders/order_items have an INSERT policy — migration 054 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'order_items'
      AND cmd = 'UPDATE'
  ) THEN
    RAISE EXCEPTION
      'order_items have an UPDATE policy — migration 054 did not apply';
  END IF;

  -- Agents (and up) change the state of their orders, with WITH CHECK so
  -- a row cannot be moved to another account or linked to a foreign deal.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND cmd = 'UPDATE'
      AND coalesce(qual, '') LIKE '%''agent''%'
      AND coalesce(with_check, '') LIKE '%''agent''%'
      AND coalesce(with_check, '') LIKE '%deals%'
      AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%''admin''%'
  ) THEN
    RAISE EXCEPTION
      'orders UPDATE policy is missing, not agent-level or has no deal WITH CHECK — migration 054 did not apply';
  END IF;

  -- Orders keep the customer's name and phone and survive the contact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'f'
      AND confrelid = 'public.contacts'::regclass
      AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION
      'orders.contact_id must reference contacts ON DELETE SET NULL — migration 054 did not apply';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name IN ('customer_name', 'customer_phone')
      AND is_nullable = 'NO'
  ) <> 2 THEN
    RAISE EXCEPTION
      'orders.customer_name / customer_phone (NOT NULL) are missing — migration 054 did not apply';
  END IF;

  -- The sales settings (notice switches) are owner/admin only.
  FOR v_cmd IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'sales_settings'
        AND cmd = v_cmd
        AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''admin''%'
        AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        'sales_settings % policy is missing or not admin-only — migration 054 did not apply',
        v_cmd;
    END IF;
  END LOOP;

  -- Per-account consecutive numbers: the UNIQUE is the last net under
  -- the advisory lock in create_order.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (account_id, number)'
  ) THEN
    RAISE EXCEPTION
      'orders UNIQUE (account_id, number) is missing — migration 054 did not apply';
  END IF;

  -- total = subtotal + shipping is enforced by the database, not trusted
  -- from the client.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%subtotal + shipping%'
  ) THEN
    RAISE EXCEPTION
      'orders total CHECK (total = subtotal + shipping) is missing — migration 054 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.orders'::regclass
      AND tgname IN ('set_updated_at', 'orders_freeze_columns', 'orders_ledger_guard')
      AND NOT tgisinternal
    GROUP BY tgrelid
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION
      'orders set_updated_at / orders_freeze_columns / orders_ledger_guard triggers are missing — migration 054 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.order_items'::regclass
      AND tgname = 'order_items_freeze'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'order_items_freeze trigger is missing — migration 054 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.sales_settings'::regclass
      AND tgname = 'set_updated_at'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'sales_settings set_updated_at trigger is missing — migration 054 did not apply';
  END IF;

  -- create_order is the ONLY way to create an order, and it runs without
  -- RLS: SECURITY DEFINER owned by postgres, search_path pinned, callable
  -- by the signed-in user and the service role but NEVER by anon
  -- (Supabase grants anon EXECUTE by default; 054 revokes it), and its
  -- own guard (service_role or an agent of the account), the ventas
  -- module check and the contact/conversation ownership check must be in
  -- the body.
  IF to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'public.create_order(...) is missing — migration 054 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)')
      AND (NOT prosecdef
           OR pg_get_userbyid(proowner) <> 'postgres'
           OR proconfig IS NULL
           OR NOT ('search_path=public, pg_temp' = ANY(proconfig)))
  ) THEN
    RAISE EXCEPTION
      'create_order must be SECURITY DEFINER owned by postgres with search_path=public, pg_temp — migration 054 did not apply';
  END IF;

  -- The earlier signature (with p_currency) must be gone: two versions of
  -- create_order would leave the old, currency-trusting one callable.
  IF to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION
      'the old create_order(..., p_currency, ...) still exists — migration 054 did not apply';
  END IF;

  IF has_function_privilege('anon', 'public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute create_order — migration 054 did not apply';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)', 'EXECUTE')
  THEN
    RAISE EXCEPTION
      'authenticated / service_role cannot execute create_order — migration 054 did not apply';
  END IF;

  IF pg_get_functiondef('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'::regprocedure)
       NOT LIKE '%is_account_member%'
     OR pg_get_functiondef('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'::regprocedure)
       NOT LIKE '%service_role%'
  THEN
    RAISE EXCEPTION
      'create_order has no access guard (service_role or account agent) — migration 054 did not apply';
  END IF;

  IF pg_get_functiondef('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'::regprocedure)
       NOT LIKE '%''ventas''%'
  THEN
    RAISE EXCEPTION
      'create_order does not require the ventas module — migration 054 did not apply';
  END IF;

  IF pg_get_functiondef('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'::regprocedure)
       NOT LIKE '%account_id = p_account_id%'
     OR pg_get_functiondef('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'::regprocedure)
       NOT LIKE '%pg_advisory_xact_lock%'
  THEN
    RAISE EXCEPTION
      'create_order does not check account ownership / take the numbering lock — migration 054 did not apply';
  END IF;

  -- 055 instala el módulo clínica.
  IF to_regclass('public.clinic_settings') IS NULL
     OR to_regclass('public.clinic_locations') IS NULL
     OR to_regclass('public.clinic_patients') IS NULL
     OR to_regclass('public.clinic_consents') IS NULL THEN
    RAISE EXCEPTION 'clinic_* tables are missing — migration 055 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversations'
      AND column_name = 'bot_lock_until'
  ) THEN
    RAISE EXCEPTION 'conversations.bot_lock_until is missing — migration 055 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name IN ('patient_id', 'location_id')
  ) <> 2 THEN
    RAISE EXCEPTION 'booking_appointments.patient_id / location_id are missing — migration 055 did not apply';
  END IF;

  -- Consent rows outlive the contact: contact_id is the only nullable one,
  -- and the holder (contact_ref) and the accepted text (text_snapshot)
  -- travel with the row.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clinic_consents'
      AND (
        (column_name = 'contact_id' AND is_nullable = 'YES')
        OR (column_name IN ('contact_ref', 'text_snapshot') AND is_nullable = 'NO')
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'clinic_consents.contact_id must be nullable and contact_ref / text_snapshot NOT NULL — migration 055 did not apply';
  END IF;

  -- All four tables: RLS on, and exactly ONE policy that applies to SELECT
  -- (a second permissive one, or a FOR ALL, would be OR-ed in and widen it)
  -- which is the plain "any member" check. pg_policies shows the call as
  -- `is_account_member(account_id)`, without the default role.
  FOR v_table IN SELECT unnest(ARRAY[
    'clinic_settings', 'clinic_locations', 'clinic_patients', 'clinic_consents'
  ]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = to_regclass('public.' || v_table)
        AND relrowsecurity
    ) THEN
      RAISE EXCEPTION '% RLS is not enabled — migration 055 did not apply', v_table;
    END IF;

    IF (
      SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd IN ('SELECT', 'ALL')
    ) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd = 'SELECT'
        AND qual ~ '^\(?is_account_member\(account_id[^)]*\)\)?$'
        AND qual NOT LIKE '%''admin''%'
        AND qual NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% must have exactly one SELECT policy, open to every member — migration 055 did not apply',
        v_table;
    END IF;
  END LOOP;

  -- clinic_settings / clinic_locations: owner/admin write — checked by the
  -- 050 loop above. The settings write policies must also pin the urgency
  -- service to the same account (the FK alone does not).
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'clinic_settings'
      AND cmd IN ('INSERT', 'UPDATE')
      AND with_check LIKE '%booking_services%'
  ) <> 2 THEN
    RAISE EXCEPTION
      'clinic_settings write policies do not pin urgency_service_id to the account — migration 055 did not apply';
  END IF;

  -- Patients: agents write, the contact must belong to the same account,
  -- and nobody deletes (a patient with appointments is a business record).
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'clinic_patients'
      AND cmd IN ('INSERT', 'UPDATE')
      AND with_check LIKE '%''agent''%'
      AND with_check LIKE '%contacts%'
  ) <> 2 THEN
    RAISE EXCEPTION
      'clinic_patients write policies are missing or do not pin the contact to the account — migration 055 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'clinic_patients'
      AND cmd IN ('DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'clinic_patients must have no DELETE policy — migration 055 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'clinic_consents'
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'clinic_consents must be read-only for clients — migration 055 did not apply';
  END IF;

  -- A contact with a patient cannot be deleted (NO ACTION: confdeltype 'a');
  -- a contact with consents can, and the consents keep living (SET NULL: 'n').
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clinic_patients'::regclass
      AND contype = 'f'
      AND confrelid = 'public.contacts'::regclass
      AND confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION
      'clinic_patients.contact_id must reference contacts with NO ACTION — migration 055 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clinic_consents'::regclass
      AND contype = 'f'
      AND confrelid = 'public.contacts'::regclass
      AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION
      'clinic_consents.contact_id must reference contacts ON DELETE SET NULL — migration 055 did not apply';
  END IF;

  -- The appointment's patient and location are tied to its own account by
  -- composite FKs that null only their own column (ON DELETE SET NULL (col),
  -- Postgres 15+: confdelsetcols).
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.booking_appointments'::regclass
      AND contype = 'f'
      AND conname IN ('booking_appointments_patient_fk', 'booking_appointments_location_fk')
      AND array_length(conkey, 1) = 2
      AND confdeltype = 'n'
      AND confdelsetcols IS NOT NULL
  ) <> 2 THEN
    RAISE EXCEPTION
      'booking_appointments patient/location must use composite (account_id, id) FKs — migration 055 did not apply';
  END IF;

  -- clinic_consents is append-only: a BEFORE UPDATE OR DELETE row trigger
  -- (tgtype bits: row 1, before 2, insert 4, delete 8, update 16) running a
  -- hardened SECURITY DEFINER function, and no TRUNCATE for the API roles.
  -- The function body must still reject (RAISE EXCEPTION) and still tell FK
  -- actions apart (pg_trigger_depth): a later migration that empties it
  -- would otherwise leave a trigger that exists and does nothing.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.clinic_consents'::regclass
      AND t.tgname = 'clinic_consents_append_only'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype & 27) = 27
      AND (t.tgtype & 4) = 0
      AND p.prosecdef
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY(p.proconfig)
      AND p.prosrc LIKE '%RAISE EXCEPTION%'
      AND p.prosrc LIKE '%pg_trigger_depth%'
  ) THEN
    RAISE EXCEPTION
      'clinic_consents_append_only trigger is missing, disabled, emptied or not hardened — migration 055 did not apply';
  END IF;

  IF has_function_privilege('anon', 'public.clinic_consents_append_only()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.clinic_consents_append_only()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.clinic_consents_append_only()', 'EXECUTE')
  THEN
    RAISE EXCEPTION
      'clinic_consents_append_only is executable by anon/authenticated or not by service_role — migration 055 did not apply';
  END IF;

  IF has_table_privilege('anon', 'public.clinic_consents', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.clinic_consents', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.clinic_consents', 'TRUNCATE')
  THEN
    RAISE EXCEPTION
      'clinic_consents can still be truncated by an API role — migration 055 did not apply';
  END IF;

  -- 056 instala las fases 2 y 3 de la clínica: recepción, Google Calendar,
  -- llamadas por pasos y después de la cita.
  IF to_regclass('public.agenda_calendar_connections') IS NULL
     OR to_regclass('public.booking_call_settings') IS NULL
     OR to_regclass('public.booking_calls') IS NULL
     OR to_regclass('public.clinic_followups') IS NULL
     OR to_regclass('public.clinic_ratings') IS NULL
     OR to_regclass('public.clinic_day_closes') IS NULL THEN
    RAISE EXCEPTION
      'agenda_calendar_connections / booking_call_settings / booking_calls / clinic_followups / clinic_ratings / clinic_day_closes are missing — migration 056 did not apply';
  END IF;

  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name IN (
        'attendance_confirmed_at', 'google_calendar_id', 'google_dirty',
        'google_synced_at', 'google_sync_error'
      )
  ) <> 5 THEN
    RAISE EXCEPTION
      'booking_appointments.attendance_confirmed_at / google_* are missing — migration 056 did not apply';
  END IF;

  -- google_dirty arranca en true: una cita nueva siempre queda pendiente de copiar.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name = 'google_dirty'
      AND is_nullable = 'NO'
      AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments.google_dirty must be NOT NULL DEFAULT true — migration 056 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_staff'
      AND column_name = 'google_calendar_id'
  ) THEN
    RAISE EXCEPTION 'booking_staff.google_calendar_id is missing — migration 056 did not apply';
  END IF;

  -- Los ids de calendario de Google (el del profesional y el general de la
  -- conexión) caben en 300 caracteres, el mismo tope que valida el código.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_staff'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%char_length(google_calendar_id) <= 300%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agenda_calendar_connections'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%char_length(default_calendar_id) <= 300%'
  ) THEN
    RAISE EXCEPTION
      'booking_staff.google_calendar_id / agenda_calendar_connections.default_calendar_id have no length limit — migration 056 did not apply';
  END IF;

  -- Las FK compuestas (account_id, appointment_id) de las tablas nuevas
  -- necesitan este UNIQUE sobre las citas.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_appointments'::regclass
      AND contype = 'u'
      AND conname = 'booking_appointments_account_id_id_key'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments must have UNIQUE (account_id, id) — migration 056 did not apply';
  END IF;

  -- Las citas del panel llevan created_via = 'dashboard'; el CHECK de 047 no lo
  -- aceptaba, ni el de booking_events.actor (que copia created_via).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_appointments'::regclass
      AND conname = 'booking_appointments_created_via_check'
      AND pg_get_constraintdef(oid) LIKE '%''dashboard''%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_events'::regclass
      AND conname = 'booking_events_actor_check'
      AND pg_get_constraintdef(oid) LIKE '%''dashboard''%'
  ) THEN
    RAISE EXCEPTION
      'created_via / booking_events.actor must accept ''dashboard'' — migration 056 did not apply';
  END IF;

  -- Las seis tablas nuevas: RLS prendida.
  FOR v_table IN SELECT unnest(ARRAY[
    'agenda_calendar_connections', 'booking_call_settings', 'booking_calls',
    'clinic_followups', 'clinic_ratings', 'clinic_day_closes'
  ]) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = to_regclass('public.' || v_table)
        AND relrowsecurity
    ) THEN
      RAISE EXCEPTION '% RLS is not enabled — migration 056 did not apply', v_table;
    END IF;
  END LOOP;

  -- El token de Google solo lo lee el servidor: la tabla no tiene ninguna
  -- política y anon/authenticated no tienen ningún permiso sobre ella (con la
  -- RLS prendida y sin política ya no ven filas; el REVOKE es la segunda cerradura).
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'agenda_calendar_connections'
  ) THEN
    RAISE EXCEPTION
      'agenda_calendar_connections must have no policies — migration 056 did not apply';
  END IF;

  FOR v_cmd IN SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) LOOP
    IF has_table_privilege('anon', 'public.agenda_calendar_connections', v_cmd)
       OR has_table_privilege('authenticated', 'public.agenda_calendar_connections', v_cmd)
    THEN
      RAISE EXCEPTION
        'anon/authenticated still have % on agenda_calendar_connections — migration 056 did not apply',
        v_cmd;
    END IF;
  END LOOP;

  -- Las otras cinco: exactamente UNA política que aplica a SELECT (una segunda
  -- permisiva, o una FOR ALL, se sumaría con OR) y es la de "cualquier miembro".
  FOR v_table IN SELECT unnest(ARRAY[
    'booking_call_settings', 'booking_calls', 'clinic_followups',
    'clinic_ratings', 'clinic_day_closes'
  ]) LOOP
    IF (
      SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd IN ('SELECT', 'ALL')
    ) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND cmd = 'SELECT'
        AND qual ~ '^\(?is_account_member\(account_id[^)]*\)\)?$'
        AND qual NOT LIKE '%''admin''%'
        AND qual NOT LIKE '%''agent''%'
    ) THEN
      RAISE EXCEPTION
        '% must have exactly one SELECT policy, open to every member — migration 056 did not apply',
        v_table;
    END IF;
  END LOOP;

  -- Seguimientos, calificaciones y cierres: desde el navegador solo se lee.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('clinic_followups', 'clinic_ratings', 'clinic_day_closes')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'clinic_followups / clinic_ratings / clinic_day_closes must be read-only for clients — migration 056 did not apply';
  END IF;

  -- Configuración de llamadas: owner/admin escriben (INSERT y UPDATE) y nadie
  -- borra. Ninguna política de escritura puede mencionar 'agent'.
  FOR v_cmd IN SELECT unnest(ARRAY['INSERT', 'UPDATE']) LOOP
    IF (
      SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'booking_call_settings'
        AND cmd = v_cmd
        AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%''admin''%'
        AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%''agent''%'
    ) <> 1 THEN
      RAISE EXCEPTION
        'booking_call_settings % policy is missing or not admin-only — migration 056 did not apply',
        v_cmd;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'booking_call_settings'
      AND cmd IN ('DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION
      'booking_call_settings must have no DELETE policy — migration 056 did not apply';
  END IF;

  -- Llamadas: el navegador solo anota llamadas A MANO (manual, saliente, a su
  -- nombre y con un contacto de la misma cuenta); ni UPDATE ni DELETE.
  IF (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'booking_calls'
      AND cmd = 'INSERT'
      AND with_check LIKE '%''agent''%'
      AND with_check LIKE '%''manual''%'
      AND with_check LIKE '%''outbound''%'
      AND with_check LIKE '%created_by = auth.uid()%'
      AND with_check LIKE '%contacts%'
  ) <> 1
  OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'booking_calls'
      AND cmd IN ('UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION
      'booking_calls write policies are not "manual outbound calls by the agent themselves, no UPDATE/DELETE" — migration 056 did not apply';
  END IF;

  -- Un número entrante, una sola cuenta; y un intento del robot por cita.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_call_settings'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(inbound_number)%'
      AND indexdef LIKE '%inbound_number IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'booking_call_settings.inbound_number must be unique when not null — migration 056 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_calls'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(appointment_id, attempt)%'
      AND indexdef LIKE '%direction%outbound%'
      AND indexdef LIKE '%channel%robot%'
      AND indexdef LIKE '%attempt IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'booking_calls must be unique per (appointment_id, attempt) for outbound robot calls — migration 056 did not apply';
  END IF;

  -- Un CallSid de Telnyx, una sola fila; y una anotación a mano por (cita, intento).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_calls'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(provider_call_sid)%'
      AND indexdef LIKE '%provider_call_sid IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'booking_calls.provider_call_sid must be unique when not null — migration 056 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'booking_calls'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(appointment_id, attempt)%'
      AND indexdef LIKE '%channel%manual%'
      AND indexdef LIKE '%appointment_id IS NOT NULL%'
      AND indexdef LIKE '%attempt IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'booking_calls must be unique per (appointment_id, attempt) for manual calls — migration 056 did not apply';
  END IF;

  -- Un seguimiento por (cita, tipo) y una calificación por seguimiento.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'clinic_followups'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(appointment_id, kind)%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'clinic_ratings'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(followup_id)%'
  ) THEN
    RAISE EXCEPTION
      'clinic_followups (appointment_id, kind) and clinic_ratings (followup_id) must be unique — migration 056 did not apply';
  END IF;

  -- Llamadas y seguimientos se van con la cita (CASCADE: confdeltype 'c');
  -- las calificaciones sobreviven y solo anulan su columna (SET NULL (col):
  -- confdeltype 'n' con confdelsetcols). Las tres usan FK compuestas
  -- (account_id, id) hacia booking_appointments.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.booking_appointments'::regclass
      AND array_length(conkey, 1) = 2
      AND (
        (conrelid = 'public.booking_calls'::regclass AND confdeltype = 'c')
        OR (conrelid = 'public.clinic_followups'::regclass AND confdeltype = 'c')
        OR (conrelid = 'public.clinic_ratings'::regclass AND confdeltype = 'n' AND confdelsetcols IS NOT NULL)
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'booking_calls / clinic_followups / clinic_ratings must use composite (account_id, appointment_id) FKs to booking_appointments — migration 056 did not apply';
  END IF;

  -- google_dirty: BEFORE INSERT OR UPDATE por fila (tgtype: fila 1, antes 2,
  -- insert 4, update 16; sin delete 8), que solo mira lo que Google muestra y
  -- NO las columnas google_* (si no, la sincronización se dispararía a sí misma).
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.booking_appointments'::regclass
      AND t.tgname = 'mark_booking_google_dirty'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype & 23) = 23
      AND (t.tgtype & 8) = 0
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY(p.proconfig)
      AND p.prosrc LIKE '%google_dirty%'
      AND p.prosrc LIKE '%NEW.starts_at IS DISTINCT FROM OLD.starts_at%'
      AND p.prosrc LIKE '%NEW.status IS DISTINCT FROM OLD.status%'
      AND p.prosrc LIKE '%NEW.notes IS DISTINCT FROM OLD.notes%'
      AND p.prosrc NOT LIKE '%OLD.google_%'
  ) THEN
    RAISE EXCEPTION
      'mark_booking_google_dirty trigger is missing, disabled or watches the google_* columns — migration 056 did not apply';
  END IF;

  IF has_function_privilege('anon', 'public.mark_booking_google_dirty()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mark_booking_google_dirty()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.mark_booking_google_dirty()', 'EXECUTE')
  THEN
    RAISE EXCEPTION
      'mark_booking_google_dirty is executable by anon/authenticated or not by service_role — migration 056 did not apply';
  END IF;

  -- updated_at de las citas es el candado optimista del panel y de la
  -- sincronización: el set_updated_at de 047 (update_updated_at_column) lo subía
  -- en todo UPDATE, también en los que solo tocan google_*. Ahora lo atiende
  -- una función propia (BEFORE UPDATE por fila: tgtype fila 1, antes 2, update
  -- 16; sin insert 4 ni delete 8) que deja updated_at igual cuando solo
  -- cambian las cuatro columnas google_* y pone now() en cualquier otro caso.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.booking_appointments'::regclass
      AND t.tgname = 'set_updated_at'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype & 31) = 19
      AND p.proname = 'booking_appointments_set_updated_at'
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY(p.proconfig)
      AND p.prosrc LIKE '%NEW.google_dirty IS DISTINCT FROM OLD.google_dirty%'
      AND p.prosrc LIKE '%NEW.google_synced_at IS DISTINCT FROM OLD.google_synced_at%'
      AND p.prosrc LIKE '%NEW.google_calendar_id IS DISTINCT FROM OLD.google_calendar_id%'
      AND p.prosrc LIKE '%NEW.google_sync_error IS DISTINCT FROM OLD.google_sync_error%'
      AND p.prosrc LIKE '%NEW.updated_at := OLD.updated_at%'
      AND p.prosrc LIKE '%NEW.updated_at := now()%'
  ) THEN
    RAISE EXCEPTION
      'booking_appointments.set_updated_at is not booking_appointments_set_updated_at() (google_* only updates must keep updated_at) — migration 056 did not apply';
  END IF;

  IF has_function_privilege('anon', 'public.booking_appointments_set_updated_at()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.booking_appointments_set_updated_at()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.booking_appointments_set_updated_at()', 'EXECUTE')
  THEN
    RAISE EXCEPTION
      'booking_appointments_set_updated_at is executable by anon/authenticated or not by service_role — migration 056 did not apply';
  END IF;

  -- La función compartida sigue siendo la de 001 (las demás tablas la usan).
  IF pg_get_functiondef('public.update_updated_at_column()'::regprocedure)
       NOT LIKE '%NEW.updated_at = NOW()%'
  THEN
    RAISE EXCEPTION
      'update_updated_at_column() was changed — migration 056 must leave the shared helper untouched';
  END IF;

  -- TRUNCATE salta la RLS y los triggers de fila, y Supabase se lo da por
  -- defecto a anon y authenticated: 056 se lo quita en las seis tablas nuevas.
  FOR v_table IN SELECT unnest(ARRAY[
    'agenda_calendar_connections', 'booking_call_settings', 'booking_calls',
    'clinic_followups', 'clinic_ratings', 'clinic_day_closes'
  ]) LOOP
    IF has_table_privilege('anon', 'public.' || v_table, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'TRUNCATE')
    THEN
      RAISE EXCEPTION
        'anon/authenticated can still TRUNCATE % — migration 056 did not apply', v_table;
    END IF;
  END LOOP;

  -- Teléfonos E.164 de booking_call_settings: de 8 a 15 dígitos, como la app
  -- (phone-utils: [1-9]\d{7,14}). Los tres CHECK (inbound_number, caller_id,
  -- advisor_phones) con {7,14}; ninguno con el piso viejo de 7 dígitos.
  IF (
    SELECT COUNT(*) FROM pg_constraint
    WHERE conrelid = 'public.booking_call_settings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%{7,14}%'
  ) <> 3
  OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_call_settings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%{6,14}%'
  ) THEN
    RAISE EXCEPTION
      'booking_call_settings phone CHECKs must require 8 to 15 digits ({7,14}) — migration 056 did not apply';
  END IF;

  -- provider, monthly_limit, inbound_number y caller_id son de Shift, y
  -- last_test_call_at del servidor: un admin no los cambia por PostgREST. BEFORE INSERT OR UPDATE por fila (tgtype fila
  -- 1, antes 2, insert 4, update 16; sin delete 8), SIN SECURITY DEFINER (es lo
  -- que hace que current_user sea el rol de la API) y habilitado ('O' o 'A').
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.booking_call_settings'::regclass
      AND t.tgname = 'enforce_call_settings_protected_columns'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND (t.tgtype & 31) = 23
      AND NOT p.prosecdef
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY(p.proconfig)
      AND p.prosrc LIKE '%current_user IN (''authenticated'', ''anon'')%'
      AND p.prosrc LIKE '%ERRCODE = ''insufficient_privilege''%'
      AND p.prosrc LIKE '%NEW.provider IS DISTINCT FROM OLD.provider%'
      AND p.prosrc LIKE '%NEW.monthly_limit IS DISTINCT FROM OLD.monthly_limit%'
      AND p.prosrc LIKE '%NEW.inbound_number IS DISTINCT FROM OLD.inbound_number%'
      AND p.prosrc LIKE '%NEW.caller_id IS DISTINCT FROM OLD.caller_id%'
      AND p.prosrc LIKE '%NEW.inbound_number IS NOT NULL%'
      AND p.prosrc LIKE '%NEW.caller_id IS NOT NULL%'
      AND p.prosrc LIKE '%NEW.last_test_call_at IS DISTINCT FROM OLD.last_test_call_at%'
      AND p.prosrc LIKE '%NEW.last_test_call_at IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION
      'enforce_call_settings_protected_columns trigger is missing, disabled, SECURITY DEFINER or incomplete — migration 056 did not apply';
  END IF;

  IF has_function_privilege('anon', 'public.enforce_call_settings_protected_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_call_settings_protected_columns()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.enforce_call_settings_protected_columns()', 'EXECUTE')
  THEN
    RAISE EXCEPTION
      'enforce_call_settings_protected_columns is executable by anon/authenticated or not by service_role — migration 056 did not apply';
  END IF;

  -- La reserva del minuto de espera de la llamada de prueba: timestamptz, anulable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_call_settings'
      AND column_name = 'last_test_call_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      'booking_call_settings.last_test_call_at must be a nullable timestamptz — migration 056 did not apply';
  END IF;

  -- El interruptor de los seguimientos: boolean NOT NULL DEFAULT false. Sin el
  -- default en false, desplegar el código empezaría a escribirles a los
  -- pacientes de todas las clínicas antes de que Meta apruebe las plantillas.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clinic_settings'
      AND column_name = 'followups_enabled'
      AND data_type = 'boolean'
      AND is_nullable = 'NO'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION
      'clinic_settings.followups_enabled must be boolean NOT NULL DEFAULT false — migration 056 did not apply';
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
