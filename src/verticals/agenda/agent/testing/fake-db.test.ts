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
