import { describe, expect, it } from 'vitest'

import {
  actId,
  ansId,
  ansSkipId,
  parseAnswerId,
  containsHandoffWord,
  containsIntentWord,
  isHandoffOnly,
  isSkipAnswer,
  dayId,
  matchAnswerOption,
  matchChoice,
  newBookingState,
  normalizeText,
  parseOptionId,
  parseReminderId,
  remId,
  slotId,
  staffId,
  svcId,
  type OfferedOption,
} from './state'

// ============================================================
// Estado conversacional — puro: ids de opciones, normalización
// de texto (es-CO) y emparejamiento de la respuesta del cliente
// (botón/lista o texto libre) contra el último menú ofrecido.
// ============================================================

const options: OfferedOption[] = [
  { id: svcId('s1'), title: 'Corte clásico' },
  { id: svcId('s2'), title: 'Corte + barba' },
  { id: svcId('s3'), title: 'Perfilado de barba' },
]

describe('normalizeText', () => {
  it('minúsculas, sin acentos y con espacios colapsados', () => {
    expect(normalizeText('  HOLÁ,  ¿Cómo   estás? ')).toBe('hola, ¿como estas?')
    expect(normalizeText('CITA')).toBe('cita')
  })
})

describe('palabras clave', () => {
  it('detecta pedido de humano como palabra completa', () => {
    expect(containsHandoffWord('quiero hablar con una persona')).toBe(true)
    expect(containsHandoffWord('necesito un asesor')).toBe(true)
    expect(containsHandoffWord('¿me atiende un humano?')).toBe(true)
    // No debe dispararse dentro de otra palabra.
    expect(containsHandoffWord('un trato personalizado')).toBe(false)
    expect(containsHandoffWord('humanoides')).toBe(false)
  })

  it('detecta intención de agendar', () => {
    expect(containsIntentWord('hola')).toBe(true)
    expect(containsIntentWord('¡Hola! 👋')).toBe(true)
    expect(containsIntentWord('quiero agendar una cita')).toBe(true)
    expect(containsIntentWord('¿me das un turno?')).toBe(true)
    expect(containsIntentWord('cuanto vale un corte?')).toBe(true)
    expect(containsIntentWord('buenas tardes, todo bien?')).toBe(false)
    expect(containsIntentWord('gracias, hasta luego')).toBe(false)
  })

  it('acepta las palabras propias del negocio, sin acentos ni mayúsculas', () => {
    expect(containsIntentWord('quiero una sesión', ['sesión'])).toBe(true)
    expect(containsIntentWord('Necesito CONSULTA', ['consulta'])).toBe(true)
    expect(containsIntentWord('quiero una sesión')).toBe(false)
    expect(containsIntentWord('quiero una sesiones', ['sesión'])).toBe(false)
  })

  it('las palabras propias con signos de regex no lanzan', () => {
    expect(() => containsIntentWord('gracias', ['cita (vip', '[x', 'a.b', '+', '\\'])).not.toThrow()
    // los signos se quitan: "consulta (vip" queda como la frase "consulta vip"
    expect(containsIntentWord('quiero consulta vip', ['consulta (vip'])).toBe(true)
  })

  it('palabras propias demasiado cortas o muy comunes no abren el flujo', () => {
    // 2 y 3 letras: demasiado genéricas
    expect(containsIntentWord('ya voy', ['ya'])).toBe(false)
    expect(containsIntentWord('una vez', ['vez'])).toBe(false)
    // lista de palabras comunes
    for (const word of ['hora', 'horas', 'info', 'plan', 'día', 'dias', 'pregunta', 'precio', 'precios']) {
      expect(containsIntentWord(`dame la ${word}`, [word])).toBe(false)
    }
    // una palabra propia real sigue funcionando
    expect(containsIntentWord('quiero una sesión', ['sesión'])).toBe(true)
  })

  it('se queda con letras y números: "clase 🧘" cuenta como "clase"', () => {
    expect(containsIntentWord('quiero una clase 🧘', ['clase 🧘'])).toBe(true)
    expect(containsIntentWord('quiero una clase', ['clase 🧘'])).toBe(true)
    expect(containsIntentWord('subclase', ['clase 🧘'])).toBe(false)
  })

  it('los límites de palabra entienden Unicode: letras no latinas pegadas no cuentan', () => {
    expect(containsIntentWord('quiero cita🧘')).toBe(true)
    expect(containsIntentWord('citaя')).toBe(false)
    expect(containsIntentWord('яcita')).toBe(false)
  })
})

describe('ids de opción', () => {
  it('codifica y decodifica con prefijo de tipo', () => {
    expect(svcId('abc')).toBe('svc:abc')
    expect(staffId('any')).toBe('staff:any')
    expect(dayId('2026-10-19')).toBe('day:2026-10-19')
    expect(slotId('2026-10-19T14:00:00.000Z')).toBe('slot:2026-10-19T14:00:00.000Z')
    expect(actId('confirm')).toBe('act:confirm')

    expect(parseOptionId('staff:any')).toEqual({ kind: 'staff', value: 'any' })
    expect(parseOptionId('day:2026-10-19')).toEqual({
      kind: 'day',
      value: '2026-10-19',
    })
    expect(parseOptionId('basura')).toBeNull()
    expect(parseOptionId('')).toBeNull()
  })

  it('las opciones de las preguntas extra viajan como ans:<pregunta>:<n>', () => {
    expect(ansId('q-1', 0)).toBe('ans:q-1:0')
    expect(ansSkipId('q-1')).toBe('ans:q-1:skip')
    expect(parseOptionId(ansId('q-1', 2))).toEqual({ kind: 'ans', value: 'q-1:2' })
    expect(parseAnswerId('ans:q-1:2')).toEqual({ questionId: 'q-1', index: 2 })
    expect(parseAnswerId('ans:q-1:skip')).toEqual({ questionId: 'q-1', index: 'skip' })
    const uuid = '0b3c9d7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f'
    expect(parseAnswerId(ansId(uuid, 1))).toEqual({ questionId: uuid, index: 1 })
    // El id más largo posible cabe en el límite de Meta (200 en listas).
    expect(ansId(uuid, 9).length).toBeLessThan(200)
  })

  it('un id de respuesta mal formado no se interpreta', () => {
    for (const id of ['ans:', 'ans:1', 'ans::1', 'ans:q-1:x', 'svc:q-1:1', 'ans:q-1:']) {
      expect(parseAnswerId(id)).toBeNull()
    }
  })
})

describe('matchChoice', () => {
  it('un tap de botón/lista empareja por id exacto', () => {
    expect(matchChoice({ text: '', replyId: svcId('s2'), options })).toBe(
      'svc:s2',
    )
    // Id desconocido (menú viejo): no inventa.
    expect(matchChoice({ text: '', replyId: 'svc:viejo', options })).toBeNull()
  })

  it('un número elige la opción correspondiente del último menú', () => {
    expect(matchChoice({ text: '2', options })).toBe('svc:s2')
    expect(matchChoice({ text: ' 3 ', options })).toBe('svc:s3')
    expect(matchChoice({ text: '2.', options })).toBe('svc:s2')
    expect(matchChoice({ text: '9', options })).toBeNull()
    expect(matchChoice({ text: '0', options })).toBeNull()
  })

  it('texto libre empareja por título (sin acentos, case-insensitive)', () => {
    expect(matchChoice({ text: 'corte clasico', options })).toBe('svc:s1')
    expect(matchChoice({ text: 'CORTE + BARBA', options })).toBe('svc:s2')
    expect(matchChoice({ text: 'quiero el perfilado de barba', options })).toBe(
      'svc:s3',
    )
    expect(matchChoice({ text: 'algo raro', options })).toBeNull()
  })

  it('sinónimos mapean a acciones solo si el menú las ofrece', () => {
    const summary: OfferedOption[] = [
      { id: actId('confirm'), title: 'Confirmar' },
      { id: actId('reschedule'), title: 'Reprogramar' },
      { id: actId('cancel'), title: 'Cancelar' },
    ]
    expect(matchChoice({ text: 'sí', options: summary })).toBe('act:confirm')
    expect(matchChoice({ text: 'Si', options: summary })).toBe('act:confirm')
    expect(matchChoice({ text: 'dale', options: summary })).toBe('act:confirm')
    expect(matchChoice({ text: 'confirmar', options: summary })).toBe(
      'act:confirm',
    )
    expect(matchChoice({ text: 'reprogramar', options: summary })).toBe(
      'act:reschedule',
    )
    expect(matchChoice({ text: 'cancelar la cita', options: summary })).toBe(
      'act:cancel',
    )
    // 'sí' sin opción de confirmar en el menú → no empareja nada.
    expect(matchChoice({ text: 'sí', options })).toBeNull()
  })

  it('"cualquiera" empareja con la opción any de barberos', () => {
    const staffOptions: OfferedOption[] = [
      { id: staffId('st1'), title: 'Andrés' },
      { id: staffId('any'), title: 'Cualquiera' },
    ]
    expect(matchChoice({ text: 'cualquiera', options: staffOptions })).toBe(
      'staff:any',
    )
    expect(matchChoice({ text: 'el que sea', options: staffOptions })).toBe(
      'staff:any',
    )
  })
})

describe('newBookingState', () => {
  it('arma un estado inicial con fails en 0 y sin opciones', () => {
    expect(newBookingState('pick_service')).toEqual({
      step: 'pick_service',
      mode: 'book',
      options: [],
      fails: 0,
    })
    expect(newBookingState('pick_day', { mode: 'reschedule', appointmentId: 'a1' })).toMatchObject({
      step: 'pick_day',
      mode: 'reschedule',
      appointmentId: 'a1',
      fails: 0,
    })
  })
})

describe('ids del recordatorio', () => {
  it('codifica los botones del recordatorio y los decodifica exactos', () => {
    expect(remId('confirm')).toBe('rem:confirm')
    expect(remId('reschedule')).toBe('rem:reschedule')
    expect(remId('cancel')).toBe('rem:cancel')

    expect(parseReminderId('rem:confirm')).toBe('confirm')
    expect(parseReminderId('rem:reschedule')).toBe('reschedule')
    expect(parseReminderId('rem:cancel')).toBe('cancel')
  })

  it('no acepta ids de otras familias ni acciones desconocidas', () => {
    expect(parseReminderId('act:confirm')).toBeNull()
    expect(parseReminderId('svc:rem:x')).toBeNull()
    expect(parseReminderId('rem:desconocido')).toBeNull()
    expect(parseReminderId('rem:')).toBeNull()
    expect(parseReminderId('rem:confirm:extra')).toBeNull()
    expect(parseReminderId('')).toBeNull()
  })
})

describe('matchAnswerOption', () => {
  const sedes: OfferedOption[] = [
    { id: ansId('q', 0), title: 'Norte' },
    { id: ansId('q', 1), title: 'Sur' },
    { id: ansId('q', 2), title: 'Sede Cañas' },
  ]

  it('el tap manda por id y un id que no se ofreció no empareja', () => {
    expect(matchAnswerOption({ text: '', replyId: ansId('q', 1), options: sedes })).toBe(ansId('q', 1))
    expect(matchAnswerOption({ text: '', replyId: ansId('q', 9), options: sedes })).toBeNull()
  })

  it('el título entero gana, sin importar mayúsculas ni tildes', () => {
    expect(matchAnswerOption({ text: 'SUR', options: sedes })).toBe(ansId('q', 1))
    expect(matchAnswerOption({ text: ' sede  canas ', options: sedes })).toBe(ansId('q', 2))
  })

  it('un título que es un número gana sobre la posición', () => {
    const legacy: OfferedOption[] = [
      { id: ansId('q', 0), title: '2' },
      { id: ansId('q', 1), title: 'Norte' },
    ]
    expect(matchAnswerOption({ text: '2', options: legacy })).toBe(ansId('q', 0))
  })

  it('si ningún título es el número, es la posición', () => {
    expect(matchAnswerOption({ text: '2', options: sedes })).toBe(ansId('q', 1))
    expect(matchAnswerOption({ text: '3.', options: sedes })).toBe(ansId('q', 2))
    expect(matchAnswerOption({ text: '4', options: sedes })).toBeNull()
  })

  it('un título que empieza con número no se confunde con la posición', () => {
    const options: OfferedOption[] = [
      { id: ansId('q', 0), title: '2 horas' },
      { id: ansId('q', 1), title: 'Un día' },
    ]
    expect(matchAnswerOption({ text: '2 horas', options })).toBe(ansId('q', 0))
    expect(matchAnswerOption({ text: '2', options })).toBe(ansId('q', 1))
  })

  it('sin coincidencia exacta cae a lo que ya hace matchChoice', () => {
    expect(matchAnswerOption({ text: 'la sur por favor', options: sedes })).toBe(ansId('q', 1))
    expect(matchAnswerOption({ text: 'ni idea', options: sedes })).toBeNull()
    expect(matchAnswerOption({ text: '', options: sedes })).toBeNull()
  })
})

describe('isSkipAnswer', () => {
  it('acepta las palabras de salto como mensaje completo', () => {
    for (const w of ['omitir', 'Omitir.', 'NO', 'no', 'ninguno', 'Ninguna', 'no aplica', 'N/A', 'n.a.', ' No  aplica ']) {
      expect(isSkipAnswer(w)).toBe(true)
    }
  })

  it('una frase con la palabra no cuenta', () => {
    for (const w of ['no tengo', 'ninguna de las dos', 'omitir esto', 'nada', '']) {
      expect(isSkipAnswer(w)).toBe(false)
    }
  })
})

describe('isHandoffOnly', () => {
  it('solo cuando todo el mensaje es la palabra', () => {
    for (const w of ['asesor', 'Humano', 'humana', 'persona.', ' PERSONA ']) expect(isHandoffOnly(w)).toBe(true)
    for (const w of ['un asesor', 'es para una persona mayor', 'asesor por favor', '']) {
      expect(isHandoffOnly(w)).toBe(false)
    }
  })
})
