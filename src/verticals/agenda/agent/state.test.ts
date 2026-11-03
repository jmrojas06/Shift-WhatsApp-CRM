import { describe, expect, it } from 'vitest'

import {
  actId,
  ansId,
  ansSkipId,
  apptId,
  parseAnswerId,
  containsHandoffWord,
  containsIntentWord,
  containsUrgencyFloor,
  containsUrgencyWord,
  detectsUrgency,
  isHandoffOnly,
  isSkipAnswer,
  dayId,
  matchAnswerOption,
  matchAppointmentOption,
  matchChoice,
  newBookingState,
  normalizeText,
  parseOptionId,
  parseReminderTap,
  patId,
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

    expect(parseReminderTap('rem:confirm')).toEqual({ action: 'confirm', appointmentId: null })
    expect(parseReminderTap('rem:reschedule')).toEqual({ action: 'reschedule', appointmentId: null })
    expect(parseReminderTap('rem:cancel')).toEqual({ action: 'cancel', appointmentId: null })
  })

  it('no acepta ids de otras familias ni acciones desconocidas', () => {
    expect(parseReminderTap('act:confirm')).toBeNull()
    expect(parseReminderTap('svc:rem:x')).toBeNull()
    expect(parseReminderTap('rem:desconocido')).toBeNull()
    expect(parseReminderTap('rem:')).toBeNull()
    expect(parseReminderTap('')).toBeNull()
    expect(parseReminderTap('constructor')).toBeNull()
  })
})

describe('matchAppointmentOption', () => {
  const citas: OfferedOption[] = [
    { id: apptId('a1'), title: '20 oct Marta' },
    { id: apptId('a2'), title: '21 oct Marta' },
    { id: apptId('a3'), title: '21 oct Tomás' },
  ]
  const pick = (text: string, options = citas) => matchAppointmentOption({ text, options })

  it('el toque manda por id y un id que no se ofreció no empareja', () => {
    expect(matchAppointmentOption({ text: '', replyId: apptId('a2'), options: citas })).toBe(apptId('a2'))
    expect(matchAppointmentOption({ text: '', replyId: apptId('zz'), options: citas })).toBeNull()
  })

  it('un texto que coincide con una sola cita la elige', () => {
    expect(pick('Tomás')).toBe(apptId('a3'))
    expect(pick('tomas')).toBe(apptId('a3'))
    expect(pick('20 oct')).toBe(apptId('a1'))
    expect(pick('20 oct Marta')).toBe(apptId('a1'))
  })

  it('un texto que coincide con varias es un fallo, no la primera', () => {
    expect(pick('Marta')).toBeNull()
    expect(pick('21 oct')).toBeNull()
    expect(pick('oct')).toBeNull()
  })

  it('el número es la posición, también con varias coincidencias', () => {
    expect(pick('2')).toBe(apptId('a2'))
    expect(pick('3.')).toBe(apptId('a3'))
    expect(pick('4')).toBeNull()
  })

  it('el título entero gana sobre otra cita que lo contiene', () => {
    const options: OfferedOption[] = [
      { id: apptId('a1'), title: 'Marta' },
      { id: apptId('a2'), title: 'Marta Gil' },
    ]
    expect(pick('Marta', options)).toBe(apptId('a1'))
  })

  it('lo que no coincide con ninguna no elige nada', () => {
    expect(pick('Pedro')).toBeNull()
    expect(pick('')).toBeNull()
  })

  it('no toca los demás menús: matchChoice sigue eligiendo la primera coincidencia', () => {
    expect(matchChoice({ text: 'Marta', options: citas })).toBe(apptId('a1'))
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

describe('toques del recordatorio', () => {
  it('lleva el id de la cita cuando viaja en el botón', () => {
    expect(remId('confirm', 'ap-1')).toBe('rem:confirm:ap-1')
    expect(parseReminderTap('rem:confirm:ap-1')).toEqual({ action: 'confirm', appointmentId: 'ap-1' })
  })

  it('entiende la etiqueta que Meta devuelve cuando la plantilla no trae payload', () => {
    expect(parseReminderTap('Confirmar')).toEqual({ action: 'confirm', appointmentId: null, viaLabel: true })
    expect(parseReminderTap('Reprogramar')).toEqual({ action: 'reschedule', appointmentId: null, viaLabel: true })
    expect(parseReminderTap('Cancelar')).toEqual({ action: 'cancel', appointmentId: null, viaLabel: true })
  })

  it('marca las etiquetas, que cualquier otra plantilla también puede traer, y los ids no', () => {
    expect(parseReminderTap('Confirmar')?.viaLabel).toBe(true)
    expect(parseReminderTap('rem:confirm')?.viaLabel).toBeUndefined()
    expect(parseReminderTap('rem:cancel:ap-1')?.viaLabel).toBeUndefined()
  })
})

describe('palabras de urgencia', () => {
  it('compara sin tildes y por palabra completa', () => {
    const words = ['dolor', 'se me cayo']
    expect(containsUrgencyWord('Tengo mucho DOLOR', words)).toBe(true)
    expect(containsUrgencyWord('se me cayó una corona', words)).toBe(true)
    expect(containsUrgencyWord('Soy Dolores Pérez', words)).toBe(false)
  })
})

describe('el piso fijo de urgencias', () => {
  it.each([
    'me ahogo',
    'no respiro bien',
    'tengo una hemorragia',
    'se me está hinchando la cara',
    'tengo el cachete inchado',
    'tengo un flemón',
    'tengo una infección en la encía',
    'mi hijo se golpeó la boca',
    'a mi hijo se le partió un diente',
    'tengo una muela rota',
    'tengo dos muelas rotas',
    'se le quebraron los dientes',
    'se le cayó un diente',
    'tengo los dientes rotos',
    'sangro por la encía',
    'MI NIÑA SE GOLPEÓ',
    'me están saliendo flemones',
    'tiene una hinchazón enorme',
    'se le está hinchando',
  ])('abre los signos aunque la clínica no tenga lista: %j', (text) => {
    expect(containsUrgencyFloor(text)).toBe(true)
    expect(detectsUrgency(text, [])).toBe(true)
  })

  it.each([
    'quiero agendar una limpieza',
    'Soy Dolores Pérez',
    'cuánto cuesta una consulta',
    'hola buenas tardes',
    'necesito una radiografía',
    'tengo una cita el martes',
    'la roturación del terreno',
    'xhinchado',
  ])('no confunde un mensaje normal: %j', (text) => {
    expect(containsUrgencyFloor(text)).toBe(false)
    expect(detectsUrgency(text, [])).toBe(false)
  })

  it('se suma a la lista de la clínica, no la reemplaza', () => {
    expect(detectsUrgency('necesito ayuda ya', ['ayuda'])).toBe(true)
    expect(detectsUrgency('se me ahoga', ['ayuda'])).toBe(true)
    expect(detectsUrgency('necesito una limpieza', ['ayuda'])).toBe(false)
  })
})

// ------------------------------------------------------------
// Menús de decisión (autorización, marketing, signos de alarma).
//
// La autorización y el aviso de marketing solo se ACEPTAN TOCANDO el botón:
// ningún texto acepta ("acepto", "sí", "autorizo"). Un texto se puede leer
// mal (emojis, tildes, dudas, "autorizó") y una autorización tiene que ser
// explícita. Un texto con negación es un rechazo; cualquier otro, null: el
// bot vuelve a mostrar los botones y a la segunda pasa a una persona.
// ------------------------------------------------------------

const consentOptions: OfferedOption[] = [
  { id: 'act:consent_yes', title: 'Sí, acepto' },
  { id: 'act:consent_no', title: 'No acepto' },
]
const marketingOptions: OfferedOption[] = [
  { id: 'act:mkt_yes', title: 'Sí, avísame' },
  { id: 'act:mkt_no', title: 'No, gracias' },
]
const alarmOptions: OfferedOption[] = [
  { id: 'act:alarm_yes', title: 'Sí, tengo alguno' },
  { id: 'act:alarm_no', title: 'No, ninguno' },
]

describe('autorización escrita', () => {
  const options = consentOptions
  const choice = (text: string) => matchChoice({ text, options })

  it('un no nunca se lee como aceptación', () => {
    expect(choice('no acepto')).toBe('act:consent_no')
    expect(choice('no, no acepto')).toBe('act:consent_no')
    expect(choice('no autorizo')).toBe('act:consent_no')
    expect(choice('no')).toBe('act:consent_no')
  })

  it('aceptar exige tocar el botón: ningún texto acepta', () => {
    expect(choice('sí, acepto')).toBeNull()
    expect(choice('acepto')).toBeNull()
    expect(choice('autorizo')).toBeNull()
    expect(choice('ok')).toBeNull()
  })

  it('el toque del botón sí acepta (y el del rechazo, rechaza)', () => {
    expect(matchChoice({ text: '', replyId: 'act:consent_yes', options })).toBe('act:consent_yes')
    expect(matchChoice({ text: '', replyId: 'act:consent_no', options })).toBe('act:consent_no')
    expect(matchChoice({ text: 'sí, acepto', replyId: 'act:consent_yes', options })).toBe('act:consent_yes')
  })

  it.each([
    'Sí acepto',
    'sí, acepto.',
    ' ACEPTO ',
    'sí autorizo',
    'Autorizo',
    'autorizó',
    '❌ acepto',
    '✅ acepto',
    'acepto 🤔',
    'acepto :(',
    'Acepto 👍',
    'acepto 😡',
    'sí',
    'dale',
    'claro que sí',
    'ok',
  ])('ningún texto acepta: %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it.each([
    'noo autorizo',
    'nop autorizo',
    'para nada autorizo',
    'nunca autorizo',
    'tampoco autorizo',
    'ni autorizo ni nada',
    'no sé si acepto',
    'acepto, no hay problema',
    '¿qué pasa si no acepto?',
    '❌ no acepto',
    'no 🤔',
  ])('lo que trae una negación es rechazo: %j', (text) => {
    expect(choice(text)).toBe('act:consent_no')
  })

  it.each([
    '¿qué autorizo?',
    '¿qué pasa si acepto?',
    '¿si acepto me cobran?',
    'mi mamá autorizó',
    '¿acepto?',
    'acepto?',
    'si a',
    'acep',
    '1',
    '01',
    '3',
    '',
    '😀',
  ])('una duda, una pregunta o un mensaje a medias tampoco acepta: %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it('ningún número elige nada: ni acepta ni deja un rechazo en un registro de solo agregar', () => {
    for (const text of ['1', '1.', '1)', '2', '2.', '2)', '02', '3']) {
      expect(choice(text)).toBeNull()
    }
  })
})

describe('aviso de marketing escrito', () => {
  const options = marketingOptions
  const choice = (text: string) => matchChoice({ text, options })

  it.each(['sí', 'Sí.', 'sí, avísame', 'avísame', 'avisame!', '✅ sí', 'avísame 🤔'])(
    'ningún texto acepta: %j',
    (text) => {
      expect(choice(text)).toBeNull()
    },
  )

  // La pregunta es opcional y el rechazo queda en un registro: solo un mensaje que ES
  // un "no" lo registra. Una negación dentro de otra frase ("no voy a poder asistir a la
  // cita", "¿no hay parqueadero?") no es la respuesta, y registrarla perdería el aviso.
  it.each([
    'no',
    'No.',
    'no, gracias',
    'No gracias',
    'mejor no',
    'Mejor no.',
    'no señor',
    'no, señora',
  ])('un no completo es el rechazo: %j', (text) => {
    expect(choice(text)).toBe('act:mkt_no')
  })

  it.each([
    'no voy a poder asistir a la cita',
    'no puedo ir a la cita',
    '¿no hay parqueadero?',
    'no sé',
    'no estoy segura',
    'no, gracias por todo',
    'no avísame',
    'noo',
    'nunca',
    'tampoco',
    '❌ no',
    'no 🤔',
    '¿no?',
    'no, ¿dónde queda?',
  ])('una negación dentro de otra frase no es la respuesta: %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it.each(['¿avísame?', '¿qué es eso?', 'ok', 'dale', 'quizás', 'sí, gracias', '1', '2', '2.', '3', ''])(
    'una duda, una pregunta o un mensaje a medias no acepta: %j',
    (text) => {
      expect(choice(text)).toBeNull()
    },
  )

  it('el toque del botón sí acepta', () => {
    expect(matchChoice({ text: '', replyId: 'act:mkt_yes', options })).toBe('act:mkt_yes')
    expect(matchChoice({ text: '', replyId: 'act:mkt_no', options })).toBe('act:mkt_no')
  })
})

describe('signos de alarma escritos', () => {
  const options = alarmOptions
  const choice = (text: string) => matchChoice({ text, options })

  it.each([
    'no',
    'No.',
    'no, ninguno',
    'ninguno',
    'ninguna',
    'no tengo',
    'no tengo ninguno',
    'no tengo ninguna',
    'no tengo nada',
    'nada',
    'Nada.',
    'no ninguna',
    'ninguno de esos',
    'Ninguna de esas',
    'ninguno de los anteriores',
    'no ninguno de esos',
    'no ninguna de esas',
    'no tengo ninguno de esos',
    'no tengo ninguna de esas',
    'no no',
    'no, no tengo',
    'nop',
    'nope',
    'noo',
    'no gracias',
    'no señor',
    'no señora',
    'nada de eso',
    'no, nada de eso',
    'no doctora',
    'No, doctor',
    'no señorita',
    'no senorita',
    'creo que no',
    'no tengo ninguno de esos signos',
  ])('solo el mensaje completo de la lista dice que no hay signos: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_no')
  })

  it.each(['sí', 'Sí.', 'si tengo', 'sí, tengo alguno', 'tengo alguno'])(
    'el mensaje completo de la lista dice que sí hay signos: %j',
    (text) => {
      expect(choice(text)).toBe('act:alarm_yes')
    },
  )

  it.each([
    'tengo dificultad para respirar',
    'respiro mal',
    'sí, tengo fiebre',
    'fiebre alta',
    'estoy sangrando mucho',
    'se me hinchó la cara',
    'tengo la encía inflamada',
    'me cuesta tragar',
    'me dieron un golpe fuerte en la cara',
    'siento que me ahogo',
    'me falta el aire',
    'tengo calentura desde ayer',
  ])('un signo dicho con palabras va a una persona: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_yes')
  })

  it.each([
    'no puedo respirar',
    'no puedo tragar',
    'no para de sangrar',
    'la fiebre no baja',
    'no me llega el aire',
    'no tengo fiebre pero no puedo respirar',
  ])('una negación dentro de una frase CON un signo va a una persona: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_yes')
  })

  it.each([
    'no, solo me duele',
    'no sé',
    'no se',
    'no estoy seguro',
    'no tengo ni idea',
    'no siento nada',
    '¿no?',
    '¿no tengo ninguno?',
    'no, pero me duele mucho',
  ])('una negación dentro de una frase SIN un signo no descarta nada: %j', (text) => {
    // Ni dice "ve a urgencias" a ciegas ni agenda: se avisa a la clínica con los signos.
    expect(choice(text)).toBe('act:alarm_unsure')
  })

  it.each([
    'tengo mucho dolor',
    'hola',
    '¿cuáles son los signos?',
    'quiero agendar',
    '¿ninguno?',
    'ninguno?',
    '3',
    '',
  ])('lo demás no decide (el dolor, por sí solo, no es un signo de alarma): %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it.each(['ninguno 🤔', 'no 👍', 'nada :(', 'ninguno ❌', '✅ ninguno', 'no tengo ninguno 😀', 'nada de eso 🙏'])(
    'con emojis o símbolos nunca descarta los signos: %j',
    (text) => {
      expect(choice(text)).not.toBe('act:alarm_no')
    },
  )

  it('"ninguno 🤔" no decide: el bot vuelve a preguntar', () => {
    expect(choice('ninguno 🤔')).toBeNull()
  })

  it('por número, "no hay signos" no vale y "sí hay" sí (lleva a una persona)', () => {
    expect(choice('2')).toBeNull()
    expect(choice('02')).toBeNull()
    expect(choice('1')).toBe('act:alarm_yes')
  })

  it('con una pregunta nunca dice que no hay signos', () => {
    expect(choice('¿ninguno?')).not.toBe('act:alarm_no')
    expect(choice('¿no tengo ninguno?')).not.toBe('act:alarm_no')
    expect(choice('ninguno?')).not.toBe('act:alarm_no')
  })

  it('un toque de botón siempre vale', () => {
    expect(matchChoice({ text: '', replyId: 'act:alarm_no', options })).toBe('act:alarm_no')
    expect(matchChoice({ text: '', replyId: 'act:alarm_yes', options })).toBe('act:alarm_yes')
  })
})

describe('menús de decisión: nunca se acepta por accidente', () => {
  // Frases que no son un toque: no pueden acertar la opción que acepta
  // (consent_yes, mkt_yes) ni la que descarta los signos (alarm_no).
  const stray = [
    'tal vez',
    'no sé qué hacer',
    'lo que sea',
    'sí, pero antes explícame',
    'acepto, ¿y si no?',
    'dame un momento',
    '1 y 2',
    '😀',
    'sí',
    'acepto',
    'autorizo',
    'autorizó',
    '❌ acepto',
    'acepto 🤔',
    'acepto :(',
    'ninguno 🤔',
    '¿ninguno?',
  ]
  it.each([
    ['autorización', consentOptions, 'act:consent_yes'],
    ['marketing', marketingOptions, 'act:mkt_yes'],
    ['signos de alarma', alarmOptions, 'act:alarm_no'],
  ] as const)('%s', (_name, options, acceptingId) => {
    for (const text of stray) {
      expect(matchChoice({ text, options: [...options] }), text).not.toBe(acceptingId)
    }
  })

  it('el resto de los menús sigue emparejando como antes', () => {
    expect(matchChoice({ text: 'sí', options: [{ id: 'act:confirm', title: 'Confirmar' }] })).toBe(
      'act:confirm',
    )
  })
})

describe('ids nuevos', () => {
  it('paciente y cita se leen como opciones', () => {
    expect(parseOptionId(patId('new'))).toEqual({ kind: 'pat', value: 'new' })
    expect(parseOptionId(apptId('ap-1'))).toEqual({ kind: 'appt', value: 'ap-1' })
  })
})

describe('palabras de intención en una clínica', () => {
  it('"gracias por la atención" no abre el flujo de agendar', () => {
    // La clínica llama "atención" a su servicio: sale de las palabras propias.
    const clinicWords = ['cita', 'citas', 'atención', 'atenciones']
    expect(containsIntentWord('muchas gracias por la atención', clinicWords)).toBe(false)
    expect(containsIntentWord('gracias por las atenciones', clinicWords)).toBe(false)
    expect(containsIntentWord('quiero una cita', clinicWords)).toBe(true)
  })
})
