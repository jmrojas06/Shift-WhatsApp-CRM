-- ============================================================
-- 049_booking_settings_config.sql — configuración del vertical (Fase 4)
-- ============================================================
--
-- Agrega a `booking_settings` (048) lo que la página de configuración
-- necesita y aún no vive en el esquema:
--
--   1. `address` — dirección del negocio (texto libre). No cabe en
--      `accounts` (core) y es del vertical: aquí su casa.
--   2. `bot_texts` — overrides del copy del bot en jsonb. Las claves,
--      tipos y longitudes los valida la API
--      (src/verticals/barberia/bot-texts.ts); aquí solo se garantiza
--      que la columna exista, nunca sea NULL y sea un OBJETO jsonb
--      (no array/escalar) para que el merge del controlador no tenga
--      que defenderse de basura estructural.
--
-- Todo lo demás de la configuración (servicios, barberos, relación,
-- horarios, bloqueos, moneda y la señal de 2 h) ya tiene casa desde
-- 047/048: esta migración NO duplica nada.
--
-- Idempotente: IF NOT EXISTS / DROP IF EXISTS en todo.
-- ============================================================

ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS bot_texts jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE booking_settings
  DROP CONSTRAINT IF EXISTS booking_settings_bot_texts_object_check;

ALTER TABLE booking_settings
  ADD CONSTRAINT booking_settings_bot_texts_object_check
  CHECK (jsonb_typeof(bot_texts) = 'object');
