'use client'

// ============================================================
// Nueva cita desde el panel.
//
// Pasos en una sola pantalla: contacto (buscar o nuevo) → paciente
// (solo clínicas) → atención y quién atiende → día y hora → avisar.
// Guarda con POST /api/verticals/agenda/appointments; las reglas
// (choques, horario, sillones) las decide la ruta y aquí solo se dicen
// en palabras simples. Si la hora queda fuera del horario, se pregunta
// "¿Agendar igual?" y se reintenta con `outside_hours_ok`.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'
import type { CalendarApi, PatientChoice } from '@/verticals/agenda/calendar-api'
import type {
  CalendarData,
  ContactOption,
  ContactSource,
  PatientOption,
} from '@/verticals/agenda/calendar-data'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'

import { DialogFrame } from './dialog-frame'
import { SlotPicker } from './slot-picker'

export interface NewAppointmentInitial {
  /** Columna donde se hizo clic; null = sin profesional elegido. */
  staffId: string | null
  /** Hora donde se hizo clic; null = el botón "Nueva cita". */
  startsAt: Date | null
  /** Día que mostraba el calendario. */
  dateKey: string
}

interface NewAppointmentDialogProps {
  data: CalendarData
  labels: AgendaLabels
  clinic: boolean
  api: CalendarApi
  contacts: ContactSource
  initial: NewAppointmentInitial
  todayKey: string
  onClose: () => void
  onSaved: () => void
}

const ANY = 'any'
const OTHER_PATIENT = '__other__'

/** Los pacientes ya leídos de UN contacto (si cambia el contacto, dejan de valer). */
interface PatientsLoaded {
  contactId: string
  patients: PatientOption[]
}

const contactLine = (c: ContactOption): string => c.name?.trim() || c.phone || T.noName

export function NewAppointmentDialog(props: NewAppointmentDialogProps) {
  const { data, labels, clinic, api, contacts, initial, todayKey } = props

  const services = useMemo(() => data.services.filter((s) => s.isActive), [data.services])
  const initialParts = initial.startsAt ? zonedParts(initial.startsAt) : null

  // ---- contacto ----
  const [contactMode, setContactMode] = useState<'search' | 'new'>('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContactOption[] | null>(null)
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [contact, setContact] = useState<ContactOption | null>(null)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')

  // ---- paciente (clínicas) ----
  const [patientsLoaded, setPatientsLoaded] = useState<PatientsLoaded | null>(null)
  const [patientChoice, setPatientChoice] = useState<string>(OTHER_PATIENT)
  const [patientName, setPatientName] = useState('')

  // ---- atención, profesional, día y hora ----
  const [serviceId, setServiceId] = useState<string>(services.length === 1 ? services[0].id : '')
  const [staffChoice, setStaffChoice] = useState<string>(initial.staffId ?? ANY)
  const [dateKey, setDateKey] = useState(initialParts?.dateKey ?? (initial.dateKey < todayKey ? todayKey : initial.dateKey))
  const [time, setTime] = useState(
    initialParts ? `${String(initialParts.hour).padStart(2, '0')}:${String(initialParts.minute).padStart(2, '0')}` : '',
  )
  /** Quiénes están libres a la hora elegida de la lista; null si se escribió a mano. */
  const [slotStaff, setSlotStaff] = useState<string[] | null>(null)

  const [notify, setNotify] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outsidePrompt, setOutsidePrompt] = useState(false)
  /** Sube cuando hay que volver a pedir las horas libres (alguien se llevó la elegida). */
  const [slotsVersion, setSlotsVersion] = useState(0)

  const staffForService = useMemo(
    () =>
      serviceId
        ? data.staff.filter(
            (s) => s.isActive && data.staffServices.some((l) => l.staffId === s.id && l.serviceId === serviceId),
          )
        : [],
    [data.staff, data.staffServices, serviceId],
  )
  // Quien se eligió en el calendario deja de valer si no atiende la atención elegida.
  const effectiveStaffChoice =
    staffChoice === ANY || staffForService.some((s) => s.id === staffChoice) ? staffChoice : ANY

  // ---- búsqueda de contactos (con pausa para no consultar en cada tecla) ----
  const searchText = query.trim()
  const searching = contactMode === 'search' && !contact && searchText.length >= 2
  const searchSeq = useRef(0)
  useEffect(() => {
    if (!searching) return
    const seq = ++searchSeq.current
    const timer = setTimeout(() => {
      setSearchState('loading')
      contacts
        .search(searchText)
        .then((found) => {
          if (seq !== searchSeq.current) return
          setResults(found)
          setSearchState('idle')
        })
        .catch(() => {
          if (seq !== searchSeq.current) return
          setResults(null)
          setSearchState('error')
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [searching, searchText, contacts])
  // Con menos de 2 letras no hay búsqueda: lo que quedó de antes no se muestra.
  const shownResults = searching ? results : null
  const shownSearchState = searching ? searchState : 'idle'

  // ---- pacientes del contacto elegido (clínicas) ----
  useEffect(() => {
    if (!clinic || !contact) return
    let cancelled = false
    const contactId = contact.id
    contacts
      .patients(contactId)
      .then((patients) => {
        if (cancelled) return
        setPatientsLoaded({ contactId, patients })
        setPatientChoice(patients.length > 0 ? patients[0].id : OTHER_PATIENT)
      })
      .catch(() => {
        if (!cancelled) setPatientsLoaded({ contactId, patients: [] })
      })
    return () => {
      cancelled = true
    }
  }, [clinic, contact, contacts])

  const patientsReady = contact !== null && patientsLoaded?.contactId === contact.id
  const patientsLoading = clinic && contact !== null && !patientsReady
  const knownPatients = patientsReady ? patientsLoaded.patients : []
  const showPatientRadios = clinic && contact !== null && knownPatients.length > 0
  const showPatientName = clinic && (contactMode === 'new' || patientsReady) && (!showPatientRadios || patientChoice === OTHER_PATIENT)

  const pickContact = (picked: ContactOption) => {
    setContact(picked)
    setPatientName(picked.name?.trim() && /\p{L}/u.test(picked.name) ? picked.name.trim() : '')
    setError(null)
  }

  const staffName = (id: string | null): string => data.staff.find((s) => s.id === id)?.name ?? ''

  // Una hora elegida de la lista depende de la atención, de quien atiende y del
  // día: si algo cambia, deja de valer ella y los profesionales libres que
  // trajo. La que vino del clic en el calendario o se escribió a mano no sale
  // de la lista, así que se queda (se ve en "Otra hora"); lo que sí se suelta
  // siempre es la lista de libres, para no agendar con alguien que ya no lo está.
  const dropListChoice = () => {
    if (slotStaff !== null) setTime('')
    setSlotStaff(null)
  }

  // ---- guardar ----
  const submit = async (outsideHoursOk: boolean) => {
    setError(null)

    let contactChoice: { id: string } | { name: string; phone: string }
    if (contact) {
      contactChoice = { id: contact.id }
    } else if (contactMode === 'new') {
      const name = newName.trim()
      if (!name) return setError(T.newDialog.contactNameRequired)
      if (!parseInternationalPhone(newPhone)) return setError(T.newDialog.contactPhoneInvalid)
      contactChoice = { name, phone: newPhone.trim() }
    } else {
      return setError(T.newDialog.contactRequired)
    }

    let patient: PatientChoice = null
    if (clinic) {
      if (showPatientRadios && patientChoice !== OTHER_PATIENT) {
        patient = { id: patientChoice }
      } else {
        const name = patientName.trim() || (contactMode === 'new' ? newName.trim() : '')
        if (!name) return setError(T.newDialog.patientNameRequired)
        patient = { name }
      }
    }

    if (!serviceId) return setError(T.newDialog.serviceRequired(labels))
    if (!dateKey) return setError(T.newDialog.dayRequired)
    if (!time) return setError(T.newDialog.timeRequired)

    // "Cualquiera": quien está libre a esa hora. Con una hora escrita a mano
    // no se sabe quién, así que hay que elegir.
    let staffId = effectiveStaffChoice
    if (staffId === ANY) {
      const free = slotStaff?.[0]
      if (!free) return setError(T.newDialog.staffPlaceholder)
      staffId = free
    }

    setSubmitting(true)
    const res = await api.create({
      contact: contactChoice,
      patient,
      serviceId,
      staffId,
      startsAtIso: zonedTimeToUtc(dateKey, time).toISOString(),
      outsideHoursOk,
      notify,
    })
    setSubmitting(false)

    if (!res.ok) {
      if (res.code === 'outside_hours') {
        setOutsidePrompt(true)
        return
      }
      setOutsidePrompt(false)
      if (res.code === 'slot_taken' || res.code === 'chairs_full') {
        // Alguien se llevó la hora: se sueltan la hora y la lista y se piden las libres de nuevo.
        setTime('')
        setSlotStaff(null)
        setSlotsVersion((v) => v + 1)
      }
      return setError(res.error || T.newDialog.saveFailed)
    }

    if (res.data.notifyError) {
      toast.warning(T.newDialog.savedNotifyFailed, { description: res.data.notifyError })
    } else {
      toast.success(T.newDialog.saved(labels))
    }
    props.onSaved()
    props.onClose()
  }

  const resolvedStaffForPrompt = staffName(effectiveStaffChoice === ANY ? (slotStaff?.[0] ?? null) : effectiveStaffChoice)
  const waitingFor = !serviceId ? T.newDialog.pickServiceFirst(labels) : null

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && props.onClose()}>
      <DialogContent className="grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogFrame
          notice={
            <>
            {outsidePrompt && (
              <Alert role="alert" className="border-warning/40">
                <AlertDescription className="grid gap-2">
                  <p className="font-medium text-foreground">{T.newDialog.outsideTitle(resolvedStaffForPrompt || T.newDialog.staffSection(labels).toLowerCase())}</p>
                  <p>{T.newDialog.outsideBody}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button type="button" size="sm" disabled={submitting} onClick={() => void submit(true)}>
                      {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                      {T.newDialog.outsideConfirm}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setOutsidePrompt(false)}>
                      {T.newDialog.outsideBack}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            </>
          }
          onSubmit={() => {
            if (!submitting) void submit(false)
          }}
          footer={
            <>
              <Button type="button" variant="outline" disabled={submitting} onClick={props.onClose}>
                {T.newDialog.cancel}
              </Button>
              <Button type="submit" disabled={submitting || outsidePrompt}>
                {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                {submitting ? T.newDialog.saving : T.newDialog.save}
              </Button>
            </>
          }
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg">{T.newDialog.title(labels)}</DialogTitle>
            <DialogDescription>{T.newDialog.description}</DialogDescription>
          </DialogHeader>

          {/* ---- Contacto ---- */}
          <section className="grid gap-2" aria-labelledby="new-contact-title">
            <h3 id="new-contact-title" className="text-sm font-medium">
              {T.newDialog.contactSection}
            </h3>

            {contact ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{contactLine(contact)}</span>
                  {contact.phone && contact.name && (
                    <span className="block truncate text-xs text-muted-foreground">{contact.phone}</span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setContact(null)
                    setQuery('')
                    setResults(null)
                  }}
                >
                  <X aria-hidden="true" />
                  {T.newDialog.contactChange}
                </Button>
              </div>
            ) : contactMode === 'search' ? (
              <div className="grid gap-2">
                <Label htmlFor="new-contact-search" className="sr-only">
                  {T.newDialog.contactSearch}
                </Label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="new-contact-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={T.newDialog.contactSearchPlaceholder}
                    autoComplete="off"
                    aria-describedby="new-contact-search-status"
                    className="pl-9"
                  />
                </div>
                <div id="new-contact-search-status" aria-live="polite" className="text-sm text-muted-foreground">
                  {shownSearchState === 'loading' && T.newDialog.contactSearching}
                  {shownSearchState === 'error' && T.newDialog.contactSearchFailed}
                  {shownSearchState === 'idle' && shownResults !== null && shownResults.length === 0 && T.newDialog.contactNoResults}
                </div>
                {shownResults && shownResults.length > 0 && (
                  <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                    {shownResults.map((found) => (
                      <li key={found.id}>
                        <button
                          type="button"
                          onClick={() => pickContact(found)}
                          className="flex w-full flex-col px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:py-3"
                        >
                          <span className="truncate font-medium">{contactLine(found)}</span>
                          {found.name && found.phone && (
                            <span className="truncate text-xs text-muted-foreground">{found.phone}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit text-muted-foreground"
                  onClick={() => {
                    setContactMode('new')
                    setError(null)
                  }}
                >
                  <UserPlus aria-hidden="true" />
                  {T.newDialog.contactNew}
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="new-contact-name">{T.newDialog.contactName}</Label>
                  <Input
                    id="new-contact-name"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    autoComplete="off"
                    maxLength={120}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="new-contact-phone">{T.newDialog.contactPhone}</Label>
                  <Input
                    id="new-contact-phone"
                    type="tel"
                    inputMode="tel"
                    value={newPhone}
                    onChange={(event) => setNewPhone(event.target.value)}
                    placeholder="+57 300 123 4567"
                    autoComplete="off"
                    aria-describedby="new-contact-phone-hint"
                  />
                  <p id="new-contact-phone-hint" className="text-xs text-muted-foreground">
                    {T.newDialog.contactPhoneHint}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit text-muted-foreground"
                  onClick={() => setContactMode('search')}
                >
                  <Search aria-hidden="true" />
                  {T.newDialog.contactExisting}
                </Button>
              </div>
            )}
          </section>

          {/* ---- Paciente (clínicas) ---- */}
          {clinic && (contact || contactMode === 'new') && (
            <section className="grid gap-2" aria-labelledby="new-patient-title">
              <h3 id="new-patient-title" className="text-sm font-medium">
                {T.newDialog.patientSection}
              </h3>
              {patientsLoading && (
                <p role="status" className="text-sm text-muted-foreground">
                  {T.newDialog.patientsLoading}
                </p>
              )}
              {showPatientRadios && (
                <RadioGroup
                  aria-label={T.newDialog.patientSection}
                  value={patientChoice}
                  onValueChange={(value) => setPatientChoice(String(value))}
                >
                  {knownPatients.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm pointer-coarse:py-2">
                      <RadioGroupItem value={p.id} />
                      {p.fullName}
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm pointer-coarse:py-2">
                    <RadioGroupItem value={OTHER_PATIENT} />
                    {T.newDialog.patientOther}
                  </label>
                </RadioGroup>
              )}
              {showPatientName && (
                <div className="grid gap-2">
                  <Label htmlFor="new-patient-name">{T.newDialog.patientName}</Label>
                  <Input
                    id="new-patient-name"
                    value={patientName}
                    onChange={(event) => setPatientName(event.target.value)}
                    autoComplete="off"
                    maxLength={120}
                    aria-describedby="new-patient-name-hint"
                  />
                  <p id="new-patient-name-hint" className="text-xs text-muted-foreground">
                    {T.newDialog.patientNameHint}
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ---- Atención y quién atiende ---- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-service">{T.newDialog.serviceSection(labels)}</Label>
              <Select
                value={serviceId || null}
                onValueChange={(value) => {
                  setServiceId(value ?? '')
                  dropListChoice()
                  setOutsidePrompt(false)
                  setError(null)
                }}
              >
                <SelectTrigger id="new-service" className="w-full">
                  <SelectValue placeholder={T.newDialog.servicePlaceholder(labels)}>
                    {(value: string | null) => services.find((s) => s.id === value)?.name ?? T.newDialog.servicePlaceholder(labels)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start">
                  {services.map((service) => (
                    <SelectItem key={service.id} value={service.id}>
                      {service.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="new-staff">{T.newDialog.staffSection(labels)}</Label>
              <Select
                value={effectiveStaffChoice}
                onValueChange={(value) => {
                  setStaffChoice(value ?? ANY)
                  dropListChoice()
                  setOutsidePrompt(false)
                  setError(null)
                }}
                disabled={!serviceId}
              >
                <SelectTrigger id="new-staff" className="w-full">
                  <SelectValue>
                    {(value: string | null) =>
                      value && value !== ANY ? staffName(value) : T.newDialog.staffAny
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start">
                  {staffForService.length > 1 && <SelectItem value={ANY}>{T.newDialog.staffAny}</SelectItem>}
                  {staffForService.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {serviceId && staffForService.length === 0 && (
                <p className="text-xs text-destructive">{T.newDialog.staffNone(labels)}</p>
              )}
            </div>
          </div>

          {/* ---- Día y hora ---- */}
          <SlotPicker
            idPrefix="new"
            api={api}
            serviceId={serviceId || null}
            staffId={effectiveStaffChoice === ANY ? null : effectiveStaffChoice}
            dateKey={dateKey}
            onDateChange={(next) => {
              setDateKey(next)
              setTime('')
              setSlotStaff(null)
              setOutsidePrompt(false)
            }}
            time={time}
            onTimeChange={(next, staffIds) => {
              setTime(next)
              setSlotStaff(staffIds)
              setOutsidePrompt(false)
              setError(null)
            }}
            minDateKey={todayKey}
            waitingFor={waitingFor}
            reloadKey={slotsVersion}
          />
          {effectiveStaffChoice === ANY && slotStaff?.[0] && (
            <p className="-mt-3 text-sm text-muted-foreground">
              {T.newDialog.staffSection(labels)}: <span className="font-medium text-foreground">{staffName(slotStaff[0])}</span>
            </p>
          )}

          {/* ---- Avisar ---- */}
          <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
            <Switch id="new-notify" checked={notify} onCheckedChange={setNotify} className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor="new-notify" className="cursor-pointer leading-snug">
                {T.newDialog.notify}
              </Label>
              <p className="text-xs text-muted-foreground">{T.newDialog.notifyHint}</p>
            </div>
          </div>
        </DialogFrame>
      </DialogContent>
    </Dialog>
  )
}
