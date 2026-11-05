import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

// ============================================================
// Tarjeta de Google Calendar: lo que se ve en cada estado.
// Render estático (como contact-orders.test.tsx): los efectos no
// corren, así que no se llama a ninguna ruta ni a Google.
// ============================================================

import {
  CalendarSelect,
  ConnectedView,
  DisconnectedView,
  GoogleCalendarSection,
  type ConnectedViewProps,
} from './google-calendar-section'
import type { GoogleSettingsPayload } from './api'
import { GOOGLE_TEXTS as G } from './google-calendar-texts'

const CONNECT_HREF = '/api/integrations/google-calendar/connect'

const SETTINGS: GoogleSettingsPayload = {
  configured: true,
  connected: true,
  google_email: 'clinica@example.com',
  status: 'active',
  last_error: null,
  last_sync_at: null,
  default_calendar_id: 'primary',
}

const CALENDARS = [
  { id: 'clinica@example.com', name: 'clinica@example.com', primary: true },
  { id: 'sala-1@group.calendar.google.com', name: 'Sala 1', primary: false },
]

function connectedProps(patch: Partial<ConnectedViewProps> = {}): ConnectedViewProps {
  return {
    settings: SETTINGS,
    labels: DEFAULT_LABELS,
    calendars: CALENDARS,
    calendarsError: null,
    savingCalendar: false,
    calendarSaved: false,
    calendarError: null,
    onChooseCalendar: vi.fn(),
    onRetryCalendars: vi.fn(),
    onDisconnect: vi.fn(),
    ...patch,
  }
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('GoogleCalendarSection (primer render)', () => {
  it('mientras revisa el estado muestra un esqueleto y ningún botón de conectar', () => {
    const html = render(<GoogleCalendarSection labels={DEFAULT_LABELS} />)

    expect(html).toContain(G.title)
    expect(html).toContain(G.loading)
    expect(html).not.toContain(CONNECT_HREF)
  })
})

describe('DisconnectedView', () => {
  it('sin conexión explica la copia y ofrece el enlace para conectar', () => {
    const html = render(<DisconnectedView revoked={false} />)

    expect(html).toContain(G.intro)
    expect(html).toContain(`href="${CONNECT_HREF}"`)
    expect(html).toContain(G.connect)
  })

  it('avisa que los eventos no llevan teléfonos ni notas', () => {
    expect(render(<DisconnectedView revoked={false} />)).toContain(
      'Los eventos no incluyen teléfonos ni notas.',
    )
  })

  it('si Google revocó el permiso, dice qué pasó y ofrece Reconectar', () => {
    const html = render(<DisconnectedView revoked />)

    expect(html).toContain(G.revokedTitle)
    expect(html).toContain(G.revokedBody)
    expect(html).toContain(`href="${CONNECT_HREF}"`)
    expect(html).toContain(G.reconnect)
    expect(html).not.toContain(G.intro)
  })
})

describe('ConnectedView', () => {
  it('muestra la cuenta, la última copia, Reconectar y Desconectar', () => {
    const html = render(<ConnectedView {...connectedProps()} />)

    expect(html).toContain('clinica@example.com')
    expect(html).toContain(G.neverSynced)
    expect(html).toContain(`href="${CONNECT_HREF}"`)
    expect(html).toContain(G.reconnect)
    expect(html).toContain(G.disconnect)
    expect(html).toContain('Los eventos no incluyen teléfonos ni notas.')
  })

  it('el calendario general "primary" se ve como el calendario principal de la lista', () => {
    const html = render(<ConnectedView {...connectedProps()} />)

    expect(html).toContain(G.calendarLabel)
    expect(html).toContain('clinica@example.com (principal)')
  })

  it('mientras llegan los calendarios muestra un esqueleto, no el selector', () => {
    const html = render(<ConnectedView {...connectedProps({ calendars: null })} />)

    expect(html).toContain(G.calendarsLoading)
    expect(html).not.toContain('id="google-default-calendar"')
  })

  it('si no llegan los calendarios, dice el error y deja reintentar', () => {
    const html = render(
      <ConnectedView
        {...connectedProps({ calendars: null, calendarsError: G.calendarsFailed })}
      />,
    )

    expect(html).toContain(G.calendarsFailed)
    expect(html).toContain(G.retry)
  })

  it('el último error de la sincronización se muestra tal cual', () => {
    const html = render(
      <ConnectedView
        {...connectedProps({ settings: { ...SETTINGS, last_error: 'Google respondió un error (HTTP 500)' } })}
      />,
    )

    expect(html).toContain(G.lastErrorTitle)
    expect(html).toContain('Google respondió un error (HTTP 500)')
  })

  it('usa las palabras del negocio en la ayuda del calendario', () => {
    const html = render(
      <ConnectedView
        {...connectedProps({
          labels: { ...DEFAULT_LABELS, profesional: 'doctor', citas: 'turnos' },
        })}
      />,
    )

    // Sin artículo delante de la palabra del negocio: "tus turnos" vale para cualquier género.
    expect(html).toContain('Aquí se copian tus turnos.')
    expect(html).toContain('cada doctor puede tener su propio calendario')
  })
})

describe('CalendarSelect', () => {
  it('un calendario guardado que ya no aparece en la lista no deja el selector vacío', () => {
    const html = render(
      <CalendarSelect id="x" calendars={CALENDARS} value="borrado@group.calendar.google.com" onChange={vi.fn()} />,
    )

    expect(html).toContain(G.calendarMissing)
  })

  it('acepta opciones propias, como "Usar el calendario general"', () => {
    const html = render(
      <CalendarSelect
        id="x"
        calendars={CALENDARS}
        value="__general__"
        extraOptions={[{ value: '__general__', label: G.staffGeneral }]}
        onChange={vi.fn()}
      />,
    )

    expect(html).toContain(G.staffGeneral)
  })
})
