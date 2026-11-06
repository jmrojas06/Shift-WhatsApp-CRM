import { describe, expect, it, vi } from 'vitest'

import { createCallListApi } from './call-list-api'

const ID = '11111111-1111-4111-8111-111111111111'

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

function lastCall(fetchImpl: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined]
  return { url, init, body: init?.body ? JSON.parse(init.body as string) : null }
}

const payloadRow = {
  appointment_id: ID,
  starts_at: '2026-11-06T15:00:00.000Z',
  contact_id: 'c1',
  patient_name: null,
  contact_name: 'Ana Pérez',
  phone: '573001112233',
  staff_name: 'Dra. Rojas',
  reason: 'reminder_unanswered',
  robot_attempts: 0,
  manual_attempts: 0,
  last_robot: null,
  last_manual: null,
  robot_in_progress: false,
  can_robot_call: true,
}

describe('call-list-api: list', () => {
  it('lee la lista y devuelve las filas ya en camelCase', async () => {
    const f = fakeFetch(200, { rows: [payloadRow], outbound_enabled: true })
    const res = await createCallListApi(f as unknown as typeof fetch).list()
    expect(lastCall(f).url).toBe('/api/verticals/agenda/calls')
    expect(res).toMatchObject({
      ok: true,
      data: { outboundEnabled: true, rows: [{ appointmentId: ID, contactName: 'Ana Pérez', canRobotCall: true }] },
    })
  })

  it('descarta una fila rota y conserva las buenas', async () => {
    const f = fakeFetch(200, { rows: [{ nada: true }, payloadRow], outbound_enabled: false })
    const res = await createCallListApi(f as unknown as typeof fetch).list()
    expect(res.ok && res.data.rows).toHaveLength(1)
    expect(res.ok && res.data.outboundEnabled).toBe(false)
  })

  it('un error trae el texto y el código de la ruta', async () => {
    const f = fakeFetch(503, { error: 'Falta actualizar la base de datos.', code: 'migration_missing' })
    const res = await createCallListApi(f as unknown as typeof fetch).list()
    expect(res).toEqual({
      ok: false,
      status: 503,
      code: 'migration_missing',
      error: 'Falta actualizar la base de datos.',
    })
  })

  it('sin red devuelve un error en palabras simples, sin lanzar', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline')
    })
    const res = await createCallListApi(f as unknown as typeof fetch).list()
    expect(res).toMatchObject({ ok: false, status: 0, code: 'network' })
  })
})

describe('call-list-api: record', () => {
  it('manda el cuerpo que espera la ruta', async () => {
    const f = fakeFetch(200, { ok: true, recorded: true, attempt: 1, notified: true })
    const res = await createCallListApi(f as unknown as typeof fetch).record({
      appointmentId: ID,
      outcome: 'cancelled',
      notify: false,
    })
    const { url, init, body } = lastCall(f)
    expect(url).toBe('/api/verticals/agenda/calls')
    expect(init?.method).toBe('POST')
    expect(body).toEqual({ appointment_id: ID, outcome: 'cancelled', notify: false })
    expect(res).toEqual({
      ok: true,
      data: { recorded: true, note: null, notified: true, notifyError: null },
    })
  })

  it('trae la nota cuando la llamada no quedó en el historial y el error del aviso', async () => {
    const f = fakeFetch(200, {
      ok: true,
      recorded: false,
      attempt: null,
      note: 'Ya hay 3 llamadas.',
      notified: false,
      notify_error: 'Plantilla sin aprobar.',
    })
    const res = await createCallListApi(f as unknown as typeof fetch).record({ appointmentId: ID, outcome: 'confirmed' })
    expect(lastCall(f).body).toEqual({ appointment_id: ID, outcome: 'confirmed' })
    expect(res).toEqual({
      ok: true,
      data: { recorded: false, note: 'Ya hay 3 llamadas.', notified: false, notifyError: 'Plantilla sin aprobar.' },
    })
  })

  it('un 409 trae su código para que la pantalla recargue', async () => {
    const f = fakeFetch(409, { error: 'Esta cita ya no está activa.', code: 'not_active' })
    const res = await createCallListApi(f as unknown as typeof fetch).record({ appointmentId: ID, outcome: 'confirmed' })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'not_active' })
  })
})

describe('call-list-api: robotCall', () => {
  it('pide la llamada del robot y devuelve el intento', async () => {
    const f = fakeFetch(200, { ok: true, call_id: 'k1', attempt: 2 })
    const res = await createCallListApi(f as unknown as typeof fetch).robotCall(ID)
    const { url, init, body } = lastCall(f)
    expect(url).toBe('/api/verticals/agenda/calls/robot')
    expect(init?.method).toBe('POST')
    expect(body).toEqual({ appointment_id: ID })
    expect(res).toEqual({ ok: true, data: { attempt: 2 } })
  })

  it('si el robot no puede llamar, el texto de la ruta llega tal cual', async () => {
    const f = fakeFetch(409, { error: 'Ahora no se puede llamar: ...', code: 'outside_window' })
    const res = await createCallListApi(f as unknown as typeof fetch).robotCall(ID)
    expect(res).toEqual({ ok: false, status: 409, code: 'outside_window', error: 'Ahora no se puede llamar: ...' })
  })
})
