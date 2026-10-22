// ============================================================
// Etiquetas humanas para los mensajes del bot — es-CO.
//
// Deterministas a propósito: nada de Intl de fechas ni locales
// del sistema (varían entre versiones de ICU). Las fechas llegan
// ya descompuestas por `time.ts` y aquí solo se componen textos.
// ============================================================

import { weekdayOfKey } from './time'

const DAY_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const DAY_LONG = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
]
const MONTH_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
]
const MONTH_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

/** Hora local → '9:00 a. m.' (formato de 12 horas, estilo WhatsApp). */
export function formatTimeLabel(time: { hour: number; minute: number }): string {
  const h12 = time.hour % 12 === 0 ? 12 : time.hour % 12
  const mm = String(time.minute).padStart(2, '0')
  return `${h12}:${mm} ${time.hour < 12 ? 'a. m.' : 'p. m.'}`
}

/** 'YYYY-MM-DD' → 'mar 20 oct' (etiqueta corta de menú). */
export function formatDayLabel(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number)
  return `${DAY_SHORT[weekdayOfKey(dateKey)]} ${d} ${MONTH_SHORT[m - 1]}`
}

/** 'YYYY-MM-DD' → 'martes 20 de octubre de 2026' (resumen y confirmación). */
export function formatLongDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return `${DAY_LONG[weekdayOfKey(dateKey)]} ${d} de ${MONTH_LONG[m - 1]} de ${y}`
}

/** Símbolos de las monedas que atiende la plantilla (es-CO primero). */
const CURRENCY_SYMBOLS: Record<string, string> = {
  COP: '$',
  USD: 'US$',
  EUR: '€',
  MXN: '$',
  BRL: 'R$',
  GBP: '£',
  PEN: 'S/',
  CLP: '$',
  ARS: '$',
  CAD: 'C$',
  AUD: 'A$',
}

/** Precio → '$25.000' (miles con punto, sin centavos). */
export function formatPrice(value: number, currency: string): string {
  const code = (currency || 'COP').toUpperCase()
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `
  const amount = Math.round(Number(value) || 0)
  const grouped = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${amount < 0 ? '-' : ''}${symbol}${grouped}`
}

/** Recorta con '…' solo cuando excede el límite (títulos de Meta). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
