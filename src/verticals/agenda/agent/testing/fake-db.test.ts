import { describe, expect, it } from 'vitest'

import { asClient, makeFakeDb } from './fake-db'

describe('fake-db: upsert con onConflict', () => {
  it('una columna: choca con la fila que tiene el mismo valor', async () => {
    const db = makeFakeDb({ t: [{ id: 'a', v: 'viejo' }] })

    await asClient(db).from('t').upsert({ id: 'a', v: 'nuevo' }, { onConflict: 'id' })
    await asClient(db).from('t').upsert({ id: 'b', v: 'otra' }, { onConflict: 'id' })

    expect(db._tables.t).toEqual([
      { id: 'a', v: 'nuevo' },
      { id: 'b', v: 'otra' },
    ])
  })

  it('varias columnas ("a,b"): solo choca cuando coinciden TODAS', async () => {
    const db = makeFakeDb({
      t: [
        { a: 1, b: 'x', v: 'primera' },
        { a: 2, b: 'y', v: 'segunda' },
      ],
    })

    // Misma "a", distinta "b": no es un conflicto, es una fila nueva.
    await asClient(db).from('t').upsert({ a: 1, b: 'y', v: 'nueva' }, { onConflict: 'a,b' })
    expect(db._tables.t).toHaveLength(3)

    // Mismas dos columnas: ahora sí pisa la fila que ya estaba.
    await asClient(db).from('t').upsert({ a: 2, b: 'y', v: 'pisada' }, { onConflict: 'a,b' })
    expect(db._tables.t).toHaveLength(3)
    expect(db._tables.t.find((r) => r.a === 2 && r.b === 'y')?.v).toBe('pisada')
    expect(db._tables.t.find((r) => r.a === 1 && r.b === 'x')?.v).toBe('primera')
  })

  it('varias columnas con ignoreDuplicates: la fila que choca no se toca', async () => {
    const db = makeFakeDb({ t: [{ a: 1, b: 'x', v: 'primera' }] })

    await asClient(db).from('t').upsert({ a: 1, b: 'x', v: 'nueva' }, { onConflict: 'a,b', ignoreDuplicates: true })
    await asClient(db).from('t').upsert({ a: 1, b: 'z', v: 'otra' }, { onConflict: 'a,b', ignoreDuplicates: true })

    expect(db._tables.t).toEqual([
      { a: 1, b: 'x', v: 'primera' },
      { a: 1, b: 'z', v: 'otra' },
    ])
  })

  it('tolera espacios alrededor de las columnas ("a, b")', async () => {
    const db = makeFakeDb({ t: [{ a: 1, b: 'x', v: 'primera' }] })

    await asClient(db).from('t').upsert({ a: 1, b: 'x', v: 'pisada' }, { onConflict: 'a, b' })

    expect(db._tables.t).toEqual([{ a: 1, b: 'x', v: 'pisada' }])
  })
})

describe('fake-db: neq', () => {
  it('deja fuera solo la fila con ese valor', async () => {
    const db = makeFakeDb({ t: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })

    const { data } = await asClient(db).from('t').select('id').neq('id', 'b')

    expect(data).toEqual([{ id: 'a' }, { id: 'c' }])
  })
})

describe('fake-db: or', () => {
  it('suma condiciones por coma y trata la columna ausente como NULL', async () => {
    const db = makeFakeDb({
      t: [{ id: 'a', last: '2026-11-05T10:00:00.000Z' }, { id: 'b', last: '2026-11-05T12:00:00.000Z' }, { id: 'c' }],
    })

    const { data } = await asClient(db)
      .from('t')
      .select('id')
      .or('last.is.null,last.lt.2026-11-05T11:00:00.000Z')

    expect((data ?? []).map((row) => row.id)).toEqual(['a', 'c'])
  })

  it('entiende and(...) anidado: el recorrido por llaves (fecha, id)', async () => {
    const db = makeFakeDb({
      t: [
        { id: '1', at: '2026-11-05T10:00:00.000Z' },
        { id: '2', at: '2026-11-05T10:00:00.000Z' },
        { id: '3', at: '2026-11-05T10:00:00.000Z' },
        { id: '4', at: '2026-11-05T11:00:00.000Z' },
      ],
    })

    const { data } = await asClient(db)
      .from('t')
      .select('id')
      .or('at.gt.2026-11-05T10:00:00.000Z,and(at.eq.2026-11-05T10:00:00.000Z,id.gt.2)')
      .order('at')
      .order('id')

    expect((data ?? []).map((row) => row.id)).toEqual(['3', '4'])
  })

  it('filtra también el update: solo toca las filas que cumplen', async () => {
    const db = makeFakeDb({ t: [{ id: 'a', last: null }, { id: 'b', last: '2026-11-05T12:00:00.000Z' }] })

    const { data } = await asClient(db)
      .from('t')
      .update({ last: 'ahora' })
      .or('last.is.null,last.lt.2026-11-05T11:00:00.000Z')
      .select('id')

    expect((data ?? []).map((row) => row.id)).toEqual(['a'])
    expect(db._tables.t.find((r) => r.id === 'b')?.last).toBe('2026-11-05T12:00:00.000Z')
  })
})
