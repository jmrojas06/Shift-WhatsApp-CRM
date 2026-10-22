-- ============================================================
-- 052_agenda_vertical_key.sql — accounts.vertical_key 'barberia' → 'agenda'
-- ============================================================
--
-- Aplicar DESPUÉS de desplegar el código (que acepta 'agenda' y
-- 'barberia'; ver AGENDA_VERTICAL_KEYS) y después de 051.
--
-- El código viejo solo conoce la clave 'barberia': por eso esta
-- reescritura NO puede ir antes del despliegue. 051 (aditiva) sí va
-- antes.
--
-- Corre como postgres (SQL Editor / CLI), así que no la frena el
-- trigger de 050 (enforce_account_protected_columns), que solo bloquea
-- cuando current_user es `authenticated` o `anon`.
--
-- NO destructiva: solo cambia el valor de una columna. Idempotente: al
-- volver a correrla no queda ninguna cuenta 'barberia' y no hace nada.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de la tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

UPDATE accounts SET vertical_key = 'agenda' WHERE vertical_key = 'barberia';
