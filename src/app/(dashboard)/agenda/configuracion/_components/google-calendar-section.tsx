'use client'

// ============================================================
// Tarjeta "Google Calendar" de Configuración (solo owner/admin; la
// página ni la monta para los demás roles).
//
// Muestra en qué punto está la conexión y deja:
//   - Conectar / Reconectar: enlace normal a /connect (el navegador
//     viaja a Google y vuelve a /agenda/configuracion?google=ok|error).
//   - Elegir el calendario general (PATCH /settings). El de cada
//     profesional se elige en su ficha (staff-section).
//   - Desconectar, con confirmación.
//
// Nada de esto toca la base desde el navegador: todo va por
// /api/integrations/google-calendar/*, que nunca devuelve el token.
// Diseño: paleta suave del CRM (tokens, sin colores nuevos), estados
// de éxito/aviso con los tokens `success`/`warning`, botones de 44 px
// en pantallas táctiles y movimiento apagado con reduced-motion.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import {
  CalendarDays,
  CircleCheck,
  ExternalLink,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AgendaLabels } from '@/verticals/agenda/labels'

import { googleCalendarApi, type GoogleSettingsPayload } from './api'
import {
  GOOGLE_TEXTS as G,
  calendarSelectValue,
  calendarValueToSave,
  formatLastSync,
  readReturnFeedback,
  type CalendarOption,
  type ReturnFeedback,
} from './google-calendar-texts'

/** Dónde se ven y quitan los permisos de las apps en una cuenta de Google. */
const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections'

interface GoogleCalendarSectionProps {
  labels: AgendaLabels
}

/** El aviso de ?google=ok|error solo existe en el navegador, justo al volver de Google. */
function readInitialFeedback(): ReturnFeedback | null {
  if (typeof window === 'undefined') return null
  return readReturnFeedback(window.location.search)
}

export function GoogleCalendarSection({ labels }: GoogleCalendarSectionProps) {
  const [settings, setSettings] = useState<GoogleSettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<ReturnFeedback | null>(readInitialFeedback)

  const [calendars, setCalendars] = useState<CalendarOption[] | null>(null)
  const [calendarsError, setCalendarsError] = useState<string | null>(null)
  const [calendarsKey, setCalendarsKey] = useState(0)
  const [savingCalendar, setSavingCalendar] = useState(false)
  const [calendarSaved, setCalendarSaved] = useState(false)
  const [calendarError, setCalendarError] = useState<string | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  const [settingsKey, setSettingsKey] = useState(0)
  /** Vuelve a leer el estado de la conexión. */
  const reloadSettings = useCallback(() => setSettingsKey((key) => key + 1), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await googleCalendarApi.getSettings()
      if (cancelled) return
      if (res.ok) {
        setSettings(res.data)
        setLoadError(null)
      } else {
        setLoadError(res.error)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [settingsKey])

  // Quita ?google=... de la dirección: al recargar, el aviso no vuelve a salir.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('google') && !url.searchParams.has('reason')) return
    url.searchParams.delete('google')
    url.searchParams.delete('reason')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  // Los calendarios solo se piden con la conexión viva.
  const canListCalendars = settings?.connected === true
  useEffect(() => {
    if (!canListCalendars) return
    let cancelled = false
    void (async () => {
      const res = await googleCalendarApi.getCalendars()
      if (cancelled) return
      if (res.ok) {
        setCalendars(res.data.calendars)
        setCalendarsError(null)
      } else {
        setCalendarsError(res.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canListCalendars, calendarsKey])

  function retryCalendars() {
    setCalendars(null)
    setCalendarsError(null)
    setCalendarsKey((key) => key + 1)
    // Si Google revocó el permiso, el estado cambió: se vuelve a leer.
    reloadSettings()
  }

  async function chooseCalendar(value: string) {
    if (!calendars) return
    setSavingCalendar(true)
    setCalendarSaved(false)
    setCalendarError(null)
    const res = await googleCalendarApi.saveDefaultCalendar(calendarValueToSave(value, calendars))
    setSavingCalendar(false)
    if (!res.ok) {
      setCalendarError(res.error)
      return
    }
    setSettings(res.data)
    setCalendarSaved(true)
  }

  async function confirmDisconnect() {
    setDisconnecting(true)
    setDisconnectError(null)
    const res = await googleCalendarApi.disconnect()
    setDisconnecting(false)
    if (!res.ok) {
      setDisconnectError(res.error)
      return
    }
    setConfirmOpen(false)
    setCalendars(null)
    setCalendarsError(null)
    setCalendarSaved(false)
    setFeedback({ kind: 'success', message: G.disconnected, reason: null })
    reloadSettings()
  }

  const status = settings?.status ?? null
  const isRevoked = status === 'revoked'
  const hasProblem = status === 'error'
  const isConnected = settings?.connected === true
  const notConfigured = settings !== null && !settings.configured && !isConnected

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={
              isConnected
                ? 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/12 text-success'
                : 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground'
            }
          >
            <CalendarDays className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle>{G.title}</CardTitle>
            <CardDescription>{G.description}</CardDescription>
          </div>
          {settings && !notConfigured && (
            <Badge
              variant={isConnected ? (hasProblem ? 'warning' : 'success') : isRevoked ? 'destructive' : 'outline'}
            >
              {isConnected
                ? hasProblem
                  ? G.statusProblem
                  : G.statusConnected
                : isRevoked
                  ? G.statusRevoked
                  : G.statusNotConnected}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {feedback && (
          <Alert
            role={feedback.kind === 'success' ? 'status' : 'alert'}
            variant={feedback.kind === 'error' ? 'destructive' : 'default'}
          >
            {feedback.kind === 'success' ? <CircleCheck className="text-success" /> : <TriangleAlert />}
            <AlertDescription className={feedback.kind === 'success' ? 'text-foreground' : undefined}>
              {feedback.message}
              {feedback.reason === 'no_refresh_token' && (
                <>
                  {' '}
                  <a
                    href={GOOGLE_CONNECTIONS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium"
                  >
                    {G.viewConnections}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                </>
              )}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={G.dismiss}
                onClick={() => setFeedback(null)}
              >
                <X />
              </Button>
            </AlertAction>
          </Alert>
        )}

        {loading ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">{G.loading}</span>
            <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
        ) : loadError || !settings ? (
          <div className="space-y-3">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{loadError ?? G.loadFailed}</AlertDescription>
            </Alert>
            <Button
              variant="outline"
              onClick={() => {
                setLoading(true)
                reloadSettings()
              }}
            >
              {G.retry}
            </Button>
          </div>
        ) : notConfigured ? (
          <Alert>
            <Unplug />
            <AlertDescription>{G.notConfigured}</AlertDescription>
          </Alert>
        ) : isConnected ? (
          <ConnectedView
            settings={settings}
            labels={labels}
            calendars={calendars}
            calendarsError={calendarsError}
            savingCalendar={savingCalendar}
            calendarSaved={calendarSaved}
            calendarError={calendarError}
            onChooseCalendar={(value) => void chooseCalendar(value)}
            onRetryCalendars={retryCalendars}
            onDisconnect={() => {
              setDisconnectError(null)
              setConfirmOpen(true)
            }}
          />
        ) : (
          <DisconnectedView revoked={isRevoked} />
        )}
      </CardContent>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!disconnecting) setConfirmOpen(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{G.disconnectTitle}</DialogTitle>
            <DialogDescription>{G.disconnectBody}</DialogDescription>
          </DialogHeader>
          {disconnectError && (
            <Alert variant="destructive">
              <AlertDescription>{disconnectError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={disconnecting}>
              {G.disconnectCancel}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDisconnect()} disabled={disconnecting}>
              {disconnecting && <Loader2 className="animate-spin motion-reduce:animate-none" />}
              {disconnecting ? G.disconnecting : G.disconnectConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ------------------------------------------------------------
// Sin conexión (nunca conectado, o Google revocó el permiso)
// ------------------------------------------------------------

export function DisconnectedView({ revoked }: { revoked: boolean }) {
  return (
    <div className="space-y-4">
      {revoked ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{G.revokedTitle}</AlertTitle>
          <AlertDescription>{G.revokedBody}</AlertDescription>
        </Alert>
      ) : (
        <p className="max-w-[65ch] text-sm text-muted-foreground">{G.intro}</p>
      )}
      <PrivacyNote />
      <a href={googleCalendarApi.connectUrl} className={buttonVariants({ size: 'lg' })}>
        <CalendarDays />
        {revoked ? G.reconnect : G.connect}
      </a>
    </div>
  )
}

// ------------------------------------------------------------
// Conectado
// ------------------------------------------------------------

export interface ConnectedViewProps {
  settings: GoogleSettingsPayload
  labels: AgendaLabels
  calendars: CalendarOption[] | null
  calendarsError: string | null
  savingCalendar: boolean
  calendarSaved: boolean
  calendarError: string | null
  onChooseCalendar: (value: string) => void
  onRetryCalendars: () => void
  onDisconnect: () => void
}

export function ConnectedView({
  settings,
  labels,
  calendars,
  calendarsError,
  savingCalendar,
  calendarSaved,
  calendarError,
  onChooseCalendar,
  onRetryCalendars,
  onDisconnect,
}: ConnectedViewProps) {
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">{G.account}</dt>
          <dd className="truncate text-sm font-medium">{settings.google_email ?? G.accountUnknown}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">{G.lastSync}</dt>
          <dd className="text-sm font-medium">{formatLastSync(settings.last_sync_at)}</dd>
        </div>
      </dl>

      {settings.last_error && (
        <Alert className="border-warning/40">
          <TriangleAlert className="text-warning" />
          <AlertTitle>{G.lastErrorTitle}</AlertTitle>
          <AlertDescription>{settings.last_error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="google-default-calendar">{G.calendarLabel}</Label>
        {calendarsError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{calendarsError}</p>
            <Button variant="outline" size="sm" onClick={onRetryCalendars}>
              {G.retry}
            </Button>
          </div>
        ) : calendars === null ? (
          <div role="status">
            <span className="sr-only">{G.calendarsLoading}</span>
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted pointer-coarse:h-11 motion-reduce:animate-none" />
          </div>
        ) : (
          <CalendarSelect
            id="google-default-calendar"
            calendars={calendars}
            value={calendarSelectValue(settings.default_calendar_id, calendars)}
            disabled={savingCalendar}
            onChange={onChooseCalendar}
          />
        )}
        <div className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
          {savingCalendar ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {G.calendarSaving}
            </span>
          ) : calendarError ? (
            <span className="text-destructive">{calendarError}</span>
          ) : calendarSaved ? (
            <span className="text-success">{G.calendarSaved}</span>
          ) : (
            G.calendarHint(labels)
          )}
        </div>
      </div>

      <PrivacyNote />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <a href={googleCalendarApi.connectUrl} className={buttonVariants({ variant: 'outline' })}>
          {G.reconnect}
        </a>
        <Button variant="destructive" onClick={onDisconnect}>
          <Unplug />
          {G.disconnect}
        </Button>
      </div>
    </div>
  )
}

function PrivacyNote() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
      {G.privacy}
    </p>
  )
}

// ------------------------------------------------------------
// Selector de calendario (también lo usa la ficha del profesional)
// ------------------------------------------------------------

export function CalendarSelect({
  id,
  calendars,
  value,
  disabled,
  onChange,
  extraOptions = [],
}: {
  id: string
  calendars: CalendarOption[]
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  /** Opciones propias de quien lo usa (p. ej. "Usar el calendario general"). */
  extraOptions?: { value: string; label: string }[]
}) {
  const options = [
    ...extraOptions,
    ...calendars.map((calendar) => ({
      value: calendar.id,
      label: calendar.primary ? `${calendar.name} (${G.calendarPrimarySuffix})` : calendar.name,
    })),
  ]
  // Un calendario guardado que ya no sale en la lista se muestra aparte.
  if (!options.some((option) => option.value === value)) {
    options.push({ value, label: G.calendarMissing })
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next && next !== value) onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue>
          {(current: string | null) =>
            options.find((option) => option.value === current)?.label ?? current ?? ''
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
