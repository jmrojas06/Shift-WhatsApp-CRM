# Pulido de UI/UX del CRM — diseño

Aprobado por el usuario el 22/10/2026. Mockups:
https://claude.ai/artifact/NhXcJprJXny5mjWX4xTE2T

## Objetivo

Que el CRM se sienta como un dashboard profesional, suave para los ojos y,
sobre todo, fácil de usar desde el celular por dueños de negocios pequeños
(barberías, tiendas, joyerías). Es un trabajo de interfaz: no cambia la
lógica de negocio, la estrategia multi-tenant ni las migraciones.

## Decisiones aprobadas

1. **Paleta suave.** Grafito en vez de negro, texto hueso en vez de blanco
   puro y un verde menta de Shift como único acento.
2. **UX primero.** El panel muestra primero lo que hay que atender.
3. **Vocabulario en español:** "Pipelines" → **Embudo**; el *deal* deja de
   llamarse "negocio" y pasa a **oportunidad** (solo `messages/es.json`).
4. **Modo según el sistema** cuando la persona no ha elegido uno.

## Tokens

| Token | Oscuro | Claro |
|---|---|---|
| Fondo (`--background`) | `#131316` | `#F3F4F6` |
| Superficie 1 (`--card`) | `#1A1A1E` | `#FFFFFF` |
| Superficie 2 (`--card-2`, `--muted`) | `#212126` | `#F5F6F8` |
| Superficie 3 (`--accent`) | `#2A2A30` | `#EBECEF` |
| Línea (`--border`) | `#2B2B31` | `#E3E4E8` |
| Línea fuerte (`--input`) | `#3A3A42` | `#D2D4DA` |
| Texto (`--foreground`) | `#E6E6EA` | `#1D1D21` |
| Texto 2 (`--muted-foreground`) | `#A8A8B2` | `#50505A` |

- **Acento "shift"** (nuevo tema por defecto): botón `#45D49A` con texto
  `#06180F` en ambos modos; texto/acento sobre fondo: `#5EDBA7` (oscuro) y
  `#0B7A4B` (claro). Los acentos existentes (violeta, esmeralda, cobalto,
  ámbar, rosa) siguen disponibles en Apariencia.
- **Estados:** éxito `#5EDBA7`/`#0B7A4B`, aviso `#E8B45A`/`#8A5A00`,
  error `#F07A7A`/`#B42318`, info `#7FB0F5`/`#1D5FD1`. Fondos al 8–12 %.
- **Gráficos:** serie principal = acento; secundaria = gris neutro; sin
  arcoíris.
- **Tipografía:** Space Grotesk (títulos y cifras, 600) + Inter (interfaz,
  14 px, interlineado 1,55). Nunca cursiva en títulos.
- **Radios:** 8 px botones y campos, 12 px tarjetas, 16 px diálogos,
  píldora para badges.
- **Elevación:** oscuro sin sombra (borde fino); claro con sombra mínima
  `0 1px 2px rgb(29 29 33 / 4%)`.
- **Tamaños:** botones 36 px escritorio / 44 px móvil; campos 40 px / 44 px.
- **Movimiento:** 150–200 ms, solo `transform`/`opacity`, apagado con
  `prefers-reduced-motion`.

## Capas

### a) Tokens y tema
- `globals.css`: nuevos valores de modo claro/oscuro, bloque
  `html[data-theme="shift"]`, tokens de estado y de gráficos, fuente de
  títulos, `prefers-reduced-motion` global.
- `lib/themes.ts`: tema `shift` por defecto; preferencia de modo
  `system | light | dark`. Sin preferencia guardada → sigue
  `prefers-color-scheme` (script de arranque + `matchMedia`).
- Apariencia: opción "Sistema" junto a Claro/Oscuro.
- `components/ui/*`: tamaños táctiles en móvil, foco visible con el acento.

### b) Shell
- Barra lateral: nombre del negocio + "Shift CRM", grupos "Día a día" y
  "Crecimiento", conteo de sin leer en Bandeja.
- Encabezado: título de la página (sin duplicar el H1), botón **Crear**
  (contacto, oportunidad, difusión, automatización), modo, notificaciones.
- Móvil: barra inferior (Panel, Bandeja, Agenda, Contactos, Más). "Más"
  abre el menú completo. Si el módulo Agenda no está activo, su lugar lo
  toma Ventas o Embudo.
- Nombre de la app: "Shift CRM" en metadatos y login (sin "wacrm" ni
  "Plantilla de CRM para WhatsApp").

### c) Panel
- "Para atender": conversaciones sin leer (con la última y botón
  Responder), citas de hoy (si Agenda está activa), pedidos por cobrar
  (si Ventas está activo) y aviso de WhatsApp desconectado con Reconectar.
- "Resumen de hoy": conversaciones activas, contactos nuevos, mensajes
  enviados, primera respuesta.
- Gráfico de mensajes por día y actividad reciente agrupada por contacto.
- Solo lecturas de datos que ya existen (`/api/whatsapp/config`,
  conversaciones, citas, pedidos). Nada se inventa.

### d) Pulido por página
- Bandeja: filtros visibles como chips; barra para escribir con un "+",
  accesos a respuestas rápidas y plantillas, 44 px; fecha relativa en
  español.
- Contactos: acciones que no se salen en móvil, fechas en español,
  pluralización, formulario con "(obligatorio)", ejemplo +57, etiquetas
  legibles, errores que dicen qué hacer.
- Embudo: indicadores compactos (y plegados en móvil), colores de etapa
  sobrios, formulario de oportunidad con buscador de contacto.
- Agenda: acción principal "Marcar atendida", el resto en "Más",
  "Cancelar cita" con confirmación; "Reinstalar plantilla" fuera de la
  vista principal.
- Difusiones/Automatizaciones: botones en estado de carga mientras se
  resuelve el rol; sin CTA duplicado.
- Configuración: pestañas móviles con indicio de scroll; "Dark/Light/Violet"
  traducidos.
- Login/registro: marca, logo alineado, "Te damos la bienvenida",
  placeholders en español.
- Estados vacíos, skeletons y toasts con copy honesto.

### e) Microinteracciones y cierre
- Transiciones discretas (hover, press, aparición de paneles) con
  `prefers-reduced-motion`.
- Auditoría con web-design-guidelines y capturas antes/después.

## Verificación por capa
`npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build` con
el env de mentira del CI, y capturas en 1440 y 375, claro y oscuro, con la
cuenta Barbería Élite (sin crear ni cambiar datos).

## Fuera de alcance
- Funciones nuevas (navegar días en la agenda, crear citas a mano, etc.).
- Cambios de base de datos, RLS o APIs que escriben.
- Copiar los textos nuevos de vocabulario a en/pt/ko (allí siguen sus
  términos); los textos nuevos de interfaz sí van a los 4 idiomas.
