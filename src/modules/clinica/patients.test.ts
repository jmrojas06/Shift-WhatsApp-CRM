import { describe, expect, it } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { insertPatient, listPatients, validatePatientName } from './patients'

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = 'ct-1'
const OTHER_CONTACT = 'ct-2'

describe('validatePatientName', () => {
  it('pide nombre y apellido', () => {
    expect(validatePatientName('Juan Pérez')).toEqual({ ok: true, value: 'Juan Pérez' })
    expect(validatePatientName('  Ana   María  Ruiz ')).toEqual({ ok: true, value: 'Ana María Ruiz' })
    expect(validatePatientName('Juan')).toEqual({ ok: false })
    expect(validatePatientName('')).toEqual({ ok: false })
    expect(validatePatientName('   ')).toEqual({ ok: false })
  })

  it('rechaza números, control y textos muy largos', () => {
    expect(validatePatientName('Juan 123')).toEqual({ ok: false })
    expect(validatePatientName('Juan​ Pérez')).toEqual({ ok: false })
    expect(validatePatientName('Juan\u0000 Pérez')).toEqual({ ok: false })
    expect(validatePatientName('a b'.repeat(60))).toEqual({ ok: false })
  })

  it('acepta los nombres de verdad: tildes, apóstrofos, guiones y abreviaturas', () => {
    for (const name of [
      'María de los Ángeles Núñez',
      "Sean O'Brien",
      'Sean O’Brien',
      'Jean-Pierre Dupont',
      'Ma. Fernanda Gil',
      'José Peña Jr.',
    ]) {
      expect(validatePatientName(name)).toEqual({ ok: true, value: name })
    }
  })

  it('rechaza lo que no es un nombre: el aviso de un adjunto, emojis, etiquetas y símbolos', () => {
    for (const text of [
      '[Unsupported message type: sticker]',
      'Juan 😀 Pérez',
      '<b>Juan</b> Pérez',
      'Juan @ Pérez',
      'Juan_Pérez Gil',
      '- -',
      '. .',
    ]) {
      expect(validatePatientName(text)).toEqual({ ok: false })
    }
  })

  it('rechaza una frase: quien pide algo no está escribiendo un nombre', () => {
    for (const text of [
      'quiero pagar mi factura',
      'Quisiera agendar una consulta',
      'necesito una radiografía',
      'tengo mucho dolor',
      'Hola buenas tardes',
      'Hola Marta Ruiz',
      'Cita para mañana',
      'Muchas gracias doctora',
      'Gracias Ana',
      'Por favor ayúdame',
      'Me hace un favor',
    ]) {
      expect(validatePatientName(text)).toEqual({ ok: false })
    }
  })

  it('lo rechaza sin importar mayúsculas, tildes ni espacios de más', () => {
    for (const text of ['QUIERO PAGAR', 'Quisiéra  una  cita', '  tengo   un problema', 'HOLA   Mundo', 'Por   FAVOR   ya']) {
      expect(validatePatientName(text)).toEqual({ ok: false })
    }
  })

  it('solo cuenta la palabra entera: los nombres que la contienen siguen valiendo', () => {
    for (const name of ['Graciela Gómez', 'Holanda Pérez', 'Favorita Gil', 'Citlali Ramos', 'Carmen Quiroga']) {
      expect(validatePatientName(name)).toEqual({ ok: true, value: name })
    }
  })

  it('admite el largo máximo de la base y ni un carácter más', () => {
    const exact = `${'a'.repeat(59)} ${'b'.repeat(60)}`
    expect([...exact]).toHaveLength(120)
    expect(validatePatientName(exact)).toEqual({ ok: true, value: exact })
    expect(validatePatientName(`${exact}c`)).toEqual({ ok: false })
  })
})

describe('listPatients', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'pat-x',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    full_name: 'Nombre Apellido',
    ...overrides,
  })

  it('trae solo los pacientes de ese contacto en esa cuenta, por nombre', async () => {
    const db = makeFakeDb({
      clinic_patients: [
        row({ id: 'pat-2', full_name: 'Tomás Gil' }),
        row({ id: 'pat-1', full_name: 'Marta Ruiz' }),
        row({ id: 'pat-3', contact_id: OTHER_CONTACT, full_name: 'Ajeno Gil' }),
        row({ id: 'pat-4', account_id: OTHER_ACCOUNT, full_name: 'Otra Cuenta' }),
      ],
    })
    expect(await listPatients(asClient(db), { accountId: ACCOUNT, contactId: CONTACT })).toEqual([
      { id: 'pat-1', fullName: 'Marta Ruiz' },
      { id: 'pat-2', fullName: 'Tomás Gil' },
    ])
  })

  it('sin pacientes devuelve una lista vacía', async () => {
    const db = makeFakeDb({ clinic_patients: [] })
    expect(await listPatients(asClient(db), { accountId: ACCOUNT, contactId: CONTACT })).toEqual([])
  })

  it('si la base falla lanza, y el error no lleva datos de nadie', async () => {
    const db = makeFakeDb({ clinic_patients: [row({ full_name: 'Marta Ruiz' })] })
    db._failNext('select', 'clinic_patients', { message: 'timeout' })
    const error = await listPatients(asClient(db), { accountId: ACCOUNT, contactId: CONTACT }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('No se pudieron leer los pacientes: timeout')
  })
})

describe('insertPatient', () => {
  it('guarda al paciente en esa cuenta y ese contacto, y devuelve su id', async () => {
    const db = makeFakeDb({ clinic_patients: [] })
    const patient = await insertPatient(asClient(db), {
      accountId: ACCOUNT,
      contactId: CONTACT,
      fullName: 'Tomás Gil Ruiz',
    })
    expect(patient.fullName).toBe('Tomás Gil Ruiz')
    expect(patient.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(db._tables.clinic_patients).toEqual([
      { id: patient.id, account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil Ruiz' },
    ])
  })

  it('si la base falla lanza, y el error no lleva el nombre', async () => {
    const db = makeFakeDb({ clinic_patients: [] })
    db._failNext('insert', 'clinic_patients', { message: 'caída' })
    const error = await insertPatient(asClient(db), {
      accountId: ACCOUNT,
      contactId: CONTACT,
      fullName: 'Tomás Gil Ruiz',
    }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('No se pudo registrar al paciente: caída')
    expect(db._tables.clinic_patients).toHaveLength(0)
  })
})
