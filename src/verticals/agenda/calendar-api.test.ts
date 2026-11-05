import { describe, expect, it, vi } from 'vitest'

import { createCalendarApi } from './calendar-api'

const ID = '11111111-1111-4111-8111-111111111111'
const SERVICE = '22222222-2222-4222-8222-222222222222'
const STAFF = '33333333-3333-4333-8333-333333333333'

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

function lastCall(fetchImpl: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined]
  return { url, init, body: init?.body ? JSON.parse(init.body as string) : null }
}

describe('calendar-api: horas libres', () => {
  it('arma la consulta y entrega las horas con nombres del panel', async () => {
    const f = fakeFetch(200, {
      slots: [{ starts_at: '2026-11-10T14:00:00.000Z', staff_ids: [STAFF] }],
    })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.listSlots({ serviceId: SERVICE, dateKey: '2026-11-10', staffId: STAFF, excludeId: ID })
    const { url, init } = lastCall(f)
    expect(url).toBe(
      `/api/verticals/agenda/slots?service_id=${SERVICE}&date=2026-11-10&staff_id=${STAFF}&exclude=${ID}`,
    )
    expect(init?.method ?? 'GET').toBe('GET')
    expect(res).toEqual({
      ok: true,
      data: { slots: [{ startsAt: '2026-11-10T14:00:00.000Z', staffIds: [STAFF] }] },
    })
  })

  it('sin profesional ni cita a excluir, no manda esos parámetros', async () => {
    const f = fakeFetch(200, { slots: [] })
    const api = createCalendarApi(f as unknown as typeof fetch)
    await api.listSlots({ serviceId: SERVICE, dateKey: '2026-11-10' })
    expect(lastCall(f).url).toBe(`/api/verticals/agenda/slots?service_id=${SERVICE}&date=2026-11-10`)
  })
})

describe('calendar-api: crear', () => {
  it('manda el cuerpo que espera la ruta (contacto existente + paciente nuevo)', async () => {
    const f = fakeFetch(201, { id: ID, notified: true })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.create({
      contact: { id: ID },
      patient: { name: 'Lucía Pérez' },
      serviceId: SERVICE,
      staffId: STAFF,
      startsAtIso: '2026-11-10T14:00:00.000Z',
      outsideHoursOk: false,
      notify: true,
    })
    const { url, init, body } = lastCall(f)
    expect(url).toBe('/api/verticals/agenda/appointments')
    expect(init?.method).toBe('POST')
    expect(body).toEqual({
      contact_id: ID,
      new_patient_name: 'Lucía Pérez',
      service_id: SERVICE,
      staff_id: STAFF,
      starts_at: '2026-11-10T14:00:00.000Z',
      outside_hours_ok: false,
      notify: true,
    })
    expect(res).toEqual({ ok: true, data: { id: ID, notified: true, notifyError: null } })
  })

  it('contacto nuevo y paciente existente', async () => {
    const f = fakeFetch(201, { id: ID, notified: false, notify_error: 'No se pudo enviar el aviso por WhatsApp.' })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.create({
      contact: { name: 'Mateo Rojas', phone: '+573001234567' },
      patient: { id: STAFF },
      serviceId: SERVICE,
      staffId: STAFF,
      startsAtIso: '2026-11-10T14:00:00.000Z',
      outsideHoursOk: true,
      notify: false,
    })
    const { body } = lastCall(f)
    expect(body.new_contact).toEqual({ name: 'Mateo Rojas', phone: '+573001234567' })
    expect(body.patient_id).toBe(STAFF)
    expect(body).not.toHaveProperty('contact_id')
    expect(res).toEqual({
      ok: true,
      data: { id: ID, notified: false, notifyError: 'No se pudo enviar el aviso por WhatsApp.' },
    })
  })

  it('sin paciente (cuenta que no es clínica) no manda campos de paciente', async () => {
    const f = fakeFetch(201, { id: ID, notified: true })
    const api = createCalendarApi(f as unknown as typeof fetch)
    await api.create({
      contact: { id: ID },
      patient: null,
      serviceId: SERVICE,
      staffId: STAFF,
      startsAtIso: '2026-11-10T14:00:00.000Z',
      outsideHoursOk: false,
      notify: true,
    })
    const { body } = lastCall(f)
    expect(body).not.toHaveProperty('patient_id')
    expect(body).not.toHaveProperty('new_patient_name')
  })

  it('un 409 trae el código y el mensaje de la ruta', async () => {
    const f = fakeFetch(409, { error: 'Esa hora queda fuera del horario.', code: 'outside_hours' })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.create({
      contact: { id: ID },
      patient: null,
      serviceId: SERVICE,
      staffId: STAFF,
      startsAtIso: '2026-11-10T14:00:00.000Z',
      outsideHoursOk: false,
      notify: true,
    })
    expect(res).toEqual({ ok: false, status: 409, code: 'outside_hours', error: 'Esa hora queda fuera del horario.' })
  })
})

describe('calendar-api: mover, cancelar y estado', () => {
  it('mover usa PATCH con action move', async () => {
    const f = fakeFetch(200, { appointment: { id: ID }, notified: true })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.move(ID, {
      startsAtIso: '2026-11-11T15:00:00.000Z',
      staffId: STAFF,
      notify: true,
      outsideHoursOk: false,
    })
    const { url, init, body } = lastCall(f)
    expect(url).toBe(`/api/verticals/agenda/appointments/${ID}`)
    expect(init?.method).toBe('PATCH')
    expect(body).toEqual({
      action: 'move',
      starts_at: '2026-11-11T15:00:00.000Z',
      staff_id: STAFF,
      notify: true,
      outside_hours_ok: false,
    })
    expect(res).toEqual({ ok: true, data: { notified: true, notifyError: null } })
  })

  it('cancelar manda el motivo recortado o lo omite si está vacío', async () => {
    const f = fakeFetch(200, { appointment: { id: ID }, notified: false })
    const api = createCalendarApi(f as unknown as typeof fetch)
    await api.cancel(ID, { reason: '  pidió cancelar  ', notify: false, confirmPast: true })
    expect(lastCall(f).body).toEqual({
      action: 'cancel',
      reason: 'pidió cancelar',
      notify: false,
      confirm_past: true,
    })

    const g = fakeFetch(200, { appointment: { id: ID }, notified: false })
    await createCalendarApi(g as unknown as typeof fetch).cancel(ID, { reason: '   ', notify: true, confirmPast: false })
    expect(lastCall(g).body).not.toHaveProperty('reason')
  })

  it('cambio de estado: manda status y confirm_past', async () => {
    const f = fakeFetch(200, { appointment: { id: ID, status: 'completed' } })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.setStatus(ID, 'completed', true)
    expect(lastCall(f).body).toEqual({ status: 'completed', confirm_past: true })
    expect(res.ok).toBe(true)
  })

  it('una respuesta que no es JSON da un error legible y el status', async () => {
    const f = vi.fn(async () => new Response('<html>boom</html>', { status: 502 }))
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.setStatus(ID, 'completed', false)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(502)
      expect(res.code).toBeNull()
      expect(res.error.length).toBeGreaterThan(5)
    }
  })

  it('si el fetch falla (sin red), devuelve error sin lanzar', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('network')
    })
    const api = createCalendarApi(f as unknown as typeof fetch)
    const res = await api.listSlots({ serviceId: SERVICE, dateKey: '2026-11-10' })
    expect(res).toMatchObject({ ok: false, status: 0, code: 'network' })
  })
})
