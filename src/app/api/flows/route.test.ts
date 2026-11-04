import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type FakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import {
  TEST_ACCOUNT,
  TEST_USER,
  type TestResponse,
} from '../verticals/agenda/_lib/route-testing'

// ============================================================
// POST /api/flows, template clone path. The route, the template and
// the account setup run end to end against the shared PostgREST fake.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'admin' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () =>
    Object.assign(h.state.db as object, {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    }),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.state.db }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.state.db }))

import { POST } from './route'

const clone = async (slug: string, url = 'https://crm.example/api/flows') =>
  (await POST({
    url,
    json: async () => ({ template_slug: slug }),
  } as unknown as Request)) as unknown as TestResponse

function boot(): FakeDb {
  const db = makeFakeDb({
    profiles: [{ user_id: TEST_USER, account_id: TEST_ACCOUNT }],
  })
  h.state.db = db
  h.state.role = 'admin'
  return db
}

describe('POST /api/flows with the real_estate template', () => {
  let db: FakeDb

  beforeEach(() => {
    db = boot()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('leaves the draft flow, its tags, the funnel and the automation ready', async () => {
    const response = await clone('real_estate')

    expect(response.status).toBe(201)
    expect(db._tables.flows).toHaveLength(1)
    expect(db._tables.flows[0]).toMatchObject({
      account_id: TEST_ACCOUNT,
      status: 'draft',
      trigger_type: 'first_inbound_message',
    })
    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipeline_stages).toHaveLength(7)
    expect(db._tables.automations).toHaveLength(1)
    expect(db._tables.automations[0]).toMatchObject({
      account_id: TEST_ACCOUNT,
      user_id: TEST_USER,
      trigger_type: 'tag_added',
      is_active: true,
    })
    expect(db._tables.automation_steps.map((step) => step.step_type)).toEqual([
      'create_deal',
      'assign_conversation',
    ])
  })

  it("wires the flow and the automation to this account's own ids", async () => {
    await clone('real_estate')

    const tagIds = new Set(db._tables.tags.map((tag) => tag.id))
    const setTags = db._tables.flow_nodes.filter((node) => node.node_type === 'set_tag')
    expect(setTags.length).toBeGreaterThan(0)
    for (const node of setTags) {
      expect(tagIds).toContain((node.config as { tag_id: string }).tag_id)
    }

    const trigger = db._tables.automations[0].trigger_config as { tag_id: string }
    const qualifiedTag = db._tables.tags.find((tag) => tag.id === trigger.tag_id)
    expect(setTags.map((n) => (n.config as { tag_id: string }).tag_id)).toContain(qualifiedTag?.id)

    const deal = db._tables.automation_steps[0].step_config as {
      pipeline_id: string
      stage_id: string
    }
    expect(deal.pipeline_id).toBe(db._tables.pipelines[0].id)
    expect(deal.stage_id).toBe(db._tables.pipeline_stages[2].id)
  })

  it('serves the sample listing photo from the site, preferring the configured URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example/')

    await clone('real_estate')

    const photo = db._tables.flow_nodes.find((node) => node.node_type === 'send_media')
    expect((photo?.config as { media_url: string }).media_url).toMatch(
      /^https:\/\/app\.example\/templates\/.+\.png$/,
    )
  })

  it('falls back to the origin of the request when no site URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')

    await clone('real_estate')

    const photo = db._tables.flow_nodes.find((node) => node.node_type === 'send_media')
    expect((photo?.config as { media_url: string }).media_url).toMatch(
      /^https:\/\/crm\.example\/templates\//,
    )
  })

  it('a second install adds a flow but never a second automation, which would double the deals', async () => {
    await clone('real_estate')
    await clone('real_estate')

    expect(db._tables.flows).toHaveLength(2)
    expect(db._tables.automations).toHaveLength(1)
    expect(db._tables.pipelines).toHaveLength(1)
  })

  it("keeps a paused automation paused on reinstall: that was the owner's decision", async () => {
    await clone('real_estate')
    db._tables.automations[0].is_active = false

    await clone('real_estate')

    expect(db._tables.automations).toHaveLength(1)
    expect(db._tables.automations[0].is_active).toBe(false)
  })

  it('refuses an agent: tags and pipelines are admin writes and this client bypasses RLS', async () => {
    h.state.role = 'agent'

    const response = await clone('real_estate')

    expect(response.status).toBe(403)
    expect(db._tables.flows ?? []).toHaveLength(0)
    expect(db._tables.tags ?? []).toHaveLength(0)
    expect(db._tables.pipelines ?? []).toHaveLength(0)
  })

  it('rolls the flow back if the automation cannot be created', async () => {
    db._failNext('insert', 'automations', { message: 'boom' })

    const response = await clone('real_estate')

    expect(response.status).toBe(500)
    expect(db._tables.flows).toHaveLength(0)
  })

  it('removes the automation if its steps fail, so a retry can install it whole', async () => {
    db._failNext('insert', 'automation_steps', { message: 'boom' })

    const failed = await clone('real_estate')
    expect(failed.status).toBe(500)
    expect(db._tables.automations).toHaveLength(0)

    const retried = await clone('real_estate')
    expect(retried.status).toBe(201)
    expect(db._tables.automations).toHaveLength(1)
    expect(db._tables.automation_steps).toHaveLength(2)
  })

  it('answers 500 without creating a flow if the account setup fails', async () => {
    db._failNext('insert', 'pipelines', { message: 'boom' })

    const response = await clone('real_estate')

    expect(response.status).toBe(500)
    expect(db._tables.flows ?? []).toHaveLength(0)
  })
})

describe('POST /api/flows with a plain template', () => {
  it('still clones for an agent and touches nothing else in the account', async () => {
    const db = boot()
    h.state.role = 'agent'

    const response = await clone('welcome_menu')

    expect(response.status).toBe(201)
    expect(db._tables.flows).toHaveLength(1)
    expect(db._tables.pipelines ?? []).toHaveLength(0)
    expect(db._tables.automations ?? []).toHaveLength(0)
  })
})
