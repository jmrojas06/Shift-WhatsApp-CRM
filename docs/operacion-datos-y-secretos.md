# Operación: respaldos, entornos y rotación de secretos

Cómo se protegen los datos y los secretos de Shift WhatsApp CRM en
producción, y qué hacer (y qué no) al rotarlos.

## 1. Entornos y proyectos Supabase

| Entorno | Dónde corre | Supabase | Notas |
| --- | --- | --- | --- |
| **Producción** | Vercel Pro + dominio propio | Proyecto de producción | El único que atiende tráfico real y WABAs. |
| **Local** | máquina de desarrollo | Supabase CLI (`supabase start`) | Replay de migraciones; datos desechables. |
| **Staging** (opcional) | Vercel Preview | Proyecto aparte | Solo si se usan previews; ver reglas. |

Reglas:

- **`ENCRYPTION_KEY` distinta por entorno.** Los tokens cifrados en un
  entorno no se descifran en otro — es aislamiento deseado, no un bug.
- Un **preview** de Vercel nunca debe apuntar al Supabase de producción
  con claves de escritura: se crea un proyecto de staging o no se usan
  previews.
- Los secretos viven en: Vercel (envs de Production), `.env.local`
  local (fuera de git) y el gestor de contraseñas del equipo (fuente de
  verdad). Nunca en el repo, issues ni capturas.
- Cambiar una env en Vercel **no** afecta a los deploys ya existentes:
  hay que redesplegar para que las funciones la lean.

## 2. Respaldos

| Dato | Dónde vive | Respaldo |
| --- | --- | --- |
| Base de datos (clientes, citas, mensajes) | Supabase Postgres | Backups del plan + export manual |
| Adjuntos de chat | Supabase Storage (bucket `chat-media`) | Export aparte: no va en el dump de Postgres |
| Config y secretos del deploy | Vercel / `.env.local` | Gestor de contraseñas |
| App y plantillas de Meta | WhatsApp Manager / Meta | Documentar IDs en el gestor |

- **Automáticos:** Supabase → Database → Backups muestra lo que retiene
  tu plan (Free: limitado; Pro: diarios + PITR opcional). Verifica que
  esté activo el día 1.
- **Export manual** (recomendado antes de cada migración y 1×/mes):
  usa la connection string directa de Project Settings → Database.

  ```bash
  pg_dump "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
    --no-owner --no-privileges -f backup-$(date +%F).sql
  ```

  Alternativa: `supabase db dump` con la CLI vinculada. El archivo
  contiene datos de clientes: guárdalo cifrado y con acceso restringido.
- **Storage:** el bucket de adjuntos no entra en el dump de Postgres;
  si el plan no lo cubre, exporta los objetos aparte (CLI/Storage API) o
  acepta y documenta el riesgo.
- **Restore:** prueba restaurar en un proyecto de staging al menos una
  vez. Un backup que nunca se restauró no es un backup.

## 3. Rotación de secretos

| Secreto | Vive en | Impacto al rotar | Procedimiento |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | Vercel + local | Los tokens de WhatsApp guardados dejan de descifrarse: los envíos fallan por cuenta | §3.1 |
| `META_APP_SECRET` | Vercel | Webhooks firmados con el secreto viejo se rechazan mientras no actualices | Acepta lista separada por comas: `docs/multi-waba.md` |
| `AUTOMATION_CRON_SECRET` + `CRON_SECRET` | Vercel + pingers | El runner responde 503/401 hasta actualizar ambos lados | Rotar juntos, con el **mismo** valor nuevo; actualizar pingers |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Las rutas server fallan hasta redesplegar | Supabase → API → rotate; actualizar env; redeploy |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel (build) | Igual; además viaja en el bundle | Rotar + **redeploy** (es build-time) |
| Tokens de Meta por cuenta | DB (cifrados) | Envíos de esa cuenta fallan | Re-guardar en Settings → WhatsApp (se re-cifran) |
| Contraseñas de usuarios | Supabase Auth | — | Reset desde Supabase o la UI |

### 3.1 Rotar `ENCRYPTION_KEY` (procedimiento especial)

`ENCRYPTION_KEY` cifra los tokens de WhatsApp (y las API keys de IA)
guardados en la base. **Rotarla sin plan deja a todas las cuentas sin
poder enviar.**

1. Avisa la ventana: hay que tocar cada cuenta, una vez.
2. Genera la nueva:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Actualiza la env en Vercel (y local) y **redeploy**.
4. Por cada cuenta: Settings → WhatsApp → volver a guardar el token.
   La UI avisa cuando un token no descifra. Al guardar, queda cifrado
   con la nueva clave.
5. Verifica con «Verificar con Meta» y un mensaje de prueba.
6. Guarda la clave vieja hasta confirmar que todo quedó migrado.

**Nunca** uses la misma clave en entornos con bases distintas, ni la
borres del gestor «porque ya no suena necesaria»: sin ella los tokens
guardados son irrecuperables (se regeneran re-guardando, pero el
servicio queda caído hasta entonces).

## 4. Qué NO hacer

- No commitear `.env.local` ni pegar secretos en issues, PRs o chats.
- No compartir `SUPABASE_SERVICE_ROLE_KEY` fuera del server.
- No rotar `ENCRYPTION_KEY` sin seguir §3.1.
- No tocar secretos «de paso» en un deploy de feature: van en su propio
  cambio, con su verificación.
- No apuntar previews a producción para «probar rápido».
