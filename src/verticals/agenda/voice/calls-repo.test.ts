import { describe, expect, it } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { bindCallSid, loadCallRow, readCallSid, SID_MAX } from './calls-repo'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// El CallSid ata la fila de `booking_calls` a UNA llamada de Telnyx. Una vez
// atado, un pedido con otro CallSid (o sin él) no es de esta llamada.
// ============================================================

const CALL_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'

function seed(call: Row = {}): FakeDb {
  return makeCallDb({ booking_calls: [callRowSeed({ id: CALL_ID, ...call })] })
}

const rowOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row

async function bind(db: FakeDb, sid: unknown) {
  const call = await loadCallRow(asDb(db), CALL_ID)
  return bindCallSid(asDb(db), call!, sid)
}

describe('readCallSid', () => {
  it('recorta espacios y el largo de la columna; lo que no es texto es vacío', () => {
    expect(readCallSid('  CA-1  ')).toBe('CA-1')
    expect(readCallSid('x'.repeat(250))).toHaveLength(SID_MAX)
    expect(readCallSid(undefined)).toBe('')
    expect(readCallSid(42)).toBe('')
  })
})

describe('bindCallSid', () => {
  it('sin CallSid en la fila: lo guarda y deja pasar', async () => {
    const db = seed()
    expect(await bind(db, 'CA-1')).toBe('ok')
    expect(rowOf(db).provider_call_sid).toBe('CA-1')
  })

  it('sin CallSid en la fila ni en el pedido: deja pasar sin escribir nada', async () => {
    const db = seed()
    expect(await bind(db, undefined)).toBe('ok')
    expect(await bind(db, '   ')).toBe('ok')
    expect(rowOf(db).provider_call_sid).toBeNull()
  })

  it('con CallSid atado: el mismo pasa y no escribe', async () => {
    const db = seed({ provider_call_sid: 'CA-1' })
    db._failNext('update', 'booking_calls', { message: 'no debía escribir' })
    expect(await bind(db, 'CA-1')).toBe('ok')
    // El fallo preparado sigue pendiente: no hubo ninguna escritura.
    await expect(
      Promise.resolve(asDb(db).from('booking_calls').update({ status: 'busy' }).eq('id', CALL_ID)),
    ).resolves.toMatchObject({ error: { message: 'no debía escribir' } })
  })

  it('con CallSid atado: otro, o ninguno, no pasa y no cambia la fila', async () => {
    const db = seed({ provider_call_sid: 'CA-1' })
    expect(await bind(db, 'CA-OTRO')).toBe('mismatch')
    expect(await bind(db, undefined)).toBe('mismatch')
    expect(await bind(db, '')).toBe('mismatch')
    expect(rowOf(db).provider_call_sid).toBe('CA-1')
  })

  it('un CallSid larguísimo se guarda recortado y el mismo vuelve a pasar', async () => {
    const db = seed()
    const long = `CA-${'x'.repeat(200)}`
    expect(await bind(db, long)).toBe('ok')
    expect(String(rowOf(db).provider_call_sid)).toHaveLength(SID_MAX)
    expect(await bind(db, long)).toBe('ok')
  })

  it('si otro pedido lo ató primero con otro CallSid (carrera), no pasa', async () => {
    const db = seed()
    const stale = await loadCallRow(asDb(db), CALL_ID)
    expect(stale?.providerCallSid).toBeNull()
    // Mientras tanto, otro pedido escribió el suyo.
    rowOf(db).provider_call_sid = 'CA-GANADOR'

    expect(await bindCallSid(asDb(db), stale!, 'CA-PERDEDOR')).toBe('mismatch')
    expect(rowOf(db).provider_call_sid).toBe('CA-GANADOR')
  })

  it('si otro pedido lo ató primero con el MISMO CallSid (reintento a la vez), pasa', async () => {
    const db = seed()
    const stale = await loadCallRow(asDb(db), CALL_ID)
    rowOf(db).provider_call_sid = 'CA-1'
    expect(await bindCallSid(asDb(db), stale!, 'CA-1')).toBe('ok')
  })

  it('dos pedidos a la vez con CallSid distintos: solo uno queda atado', async () => {
    const db = seed()
    const [a, b] = await Promise.all([bind(db, 'CA-A'), bind(db, 'CA-B')])
    expect([a, b].sort()).toEqual(['mismatch', 'ok'])
    expect(rowOf(db).provider_call_sid).toBe(a === 'ok' ? 'CA-A' : 'CA-B')
  })

  it('el CallSid ya es de OTRA llamada (23505 del índice único): no pasa', async () => {
    const db = seed()
    db._failNext('update', 'booking_calls', {
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_booking_calls_provider_sid"',
    })
    expect(await bind(db, 'CA-DE-OTRA')).toBe('mismatch')
    expect(rowOf(db).provider_call_sid).toBeNull()
  })

  it('cualquier otro fallo de la base lanza (un 500 que Telnyx puede reintentar)', async () => {
    const db = seed()
    db._failNext('update', 'booking_calls', { message: 'boom' })
    await expect(bind(db, 'CA-1')).rejects.toThrow(/CallSid/)
  })
})
