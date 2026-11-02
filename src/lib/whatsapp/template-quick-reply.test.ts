import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendTemplateMessage } from './meta-api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch() {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: 'wamid-1' }] }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sentTemplate(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
  return JSON.parse(init.body).template
}

describe('sendTemplateMessage con payloads de quick reply', () => {
  it('agrega un componente de botón por cada payload, en orden', async () => {
    const fetchMock = stubFetch()

    await sendTemplateMessage({
      phoneNumberId: '1',
      accessToken: 't',
      to: '573001112233',
      templateName: 'recordatorio_cita_clinica',
      language: 'es',
      params: ['Clínica'],
      quickReplyPayloads: ['rem:confirm:ap-1', 'rem:cancel:ap-1'],
    })

    expect(sentTemplate(fetchMock).components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Clínica' }] },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'rem:confirm:ap-1' }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: 'rem:cancel:ap-1' }],
      },
    ])
  })

  it('los payloads sin variables de cuerpo no dejan un cuerpo vacío', async () => {
    const fetchMock = stubFetch()

    await sendTemplateMessage({
      phoneNumberId: '1',
      accessToken: 't',
      to: '573001112233',
      templateName: 'recordatorio_cita_clinica',
      language: 'es',
      quickReplyPayloads: ['rem:confirm:ap-1'],
    })

    expect(sentTemplate(fetchMock).components).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'rem:confirm:ap-1' }],
      },
    ])
  })

  it('sin payloads el envío es el de siempre: solo el cuerpo', async () => {
    const fetchMock = stubFetch()

    await sendTemplateMessage({
      phoneNumberId: '1',
      accessToken: 't',
      to: '573001112233',
      templateName: 'recordatorio_cita',
      language: 'es',
      params: ['Barbería', 'Corte'],
    })

    expect(sentTemplate(fetchMock).components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Barbería' },
          { type: 'text', text: 'Corte' },
        ],
      },
    ])
  })

  it('una lista de payloads vacía no agrega componentes', async () => {
    const fetchMock = stubFetch()

    await sendTemplateMessage({
      phoneNumberId: '1',
      accessToken: 't',
      to: '573001112233',
      templateName: 'plantilla_sin_variables',
      language: 'es',
      quickReplyPayloads: [],
    })

    expect(sentTemplate(fetchMock)).not.toHaveProperty('components')
  })
})
