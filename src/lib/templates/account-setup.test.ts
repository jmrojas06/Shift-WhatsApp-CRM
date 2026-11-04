import { describe, expect, it } from 'vitest'

import { makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { ensureTemplateSetup, type TemplateSetup } from './account-setup'

const ACCOUNT = 'acc-1'
const USER = 'user-1'

const setup: TemplateSetup = {
  tags: {
    rent: { name: 'arrendar', color: '#3b82f6' },
    qualified: { name: 'calificado', color: '#22c55e' },
  },
  pipeline: {
    name: 'Inmobiliaria',
    stages: [
      { name: 'Lead nuevo', color: '#3b82f6' },
      { name: 'Calificado', color: '#eab308' },
    ],
  },
}

const install = (db: unknown) =>
  ensureTemplateSetup(db as never, { accountId: ACCOUNT, userId: USER, setup })

describe('ensureTemplateSetup', () => {
  it('creates the tags, the pipeline and its stages on an empty account', async () => {
    const db = makeFakeDb({})

    const resources = await install(db)

    expect(db._tables.tags).toHaveLength(2)
    expect(db._tables.tags[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      name: 'arrendar',
      color: '#3b82f6',
    })
    expect(resources.tagIds).toEqual({
      rent: db._tables.tags[0].id,
      qualified: db._tables.tags[1].id,
    })
    expect(db._tables.pipelines).toHaveLength(1)
    expect(resources.pipelineId).toBe(db._tables.pipelines[0].id)
    expect(db._tables.pipeline_stages.map((stage) => stage.name)).toEqual([
      'Lead nuevo',
      'Calificado',
    ])
    expect(resources.stageIdByName.Calificado).toBe(db._tables.pipeline_stages[1].id)
  })

  it('installing twice duplicates nothing and returns the same ids', async () => {
    const db = makeFakeDb({})

    const first = await install(db)
    const second = await install(db)

    expect(second).toEqual(first)
    expect(db._tables.tags).toHaveLength(2)
    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipeline_stages).toHaveLength(2)
  })

  it("reuses the owner's tag whatever its capitalisation and leaves it as it was", async () => {
    const db = makeFakeDb({
      tags: [{ id: 'own-tag', account_id: ACCOUNT, name: 'Calificado', color: '#000000' }],
    })

    const resources = await install(db)

    expect(resources.tagIds.qualified).toBe('own-tag')
    expect(db._tables.tags).toHaveLength(2)
    expect(db._tables.tags[0]).toMatchObject({ name: 'Calificado', color: '#000000' })
  })

  it("never reuses another account's tag", async () => {
    const db = makeFakeDb({
      tags: [{ id: 'foreign-tag', account_id: 'acc-2', name: 'calificado', color: '#000000' }],
    })

    const resources = await install(db)

    expect(resources.tagIds.qualified).not.toBe('foreign-tag')
    expect(db._tables.tags).toHaveLength(3)
  })

  it("adds a missing stage at the end of the owner's pipeline without touching the rest", async () => {
    const db = makeFakeDb({
      pipelines: [{ id: 'own-pipe', account_id: ACCOUNT, name: 'inmobiliaria' }],
      pipeline_stages: [
        { id: 'own-stage', pipeline_id: 'own-pipe', name: 'Mi etapa', position: 0, color: '#000' },
        { id: 'new-lead', pipeline_id: 'own-pipe', name: 'Lead nuevo', position: 1, color: '#000' },
      ],
    })

    const resources = await install(db)

    expect(resources.pipelineId).toBe('own-pipe')
    expect(resources.stageIdByName['Lead nuevo']).toBe('new-lead')
    expect(db._tables.pipeline_stages.map((stage) => [stage.name, stage.position])).toEqual([
      ['Mi etapa', 0],
      ['Lead nuevo', 1],
      ['Calificado', 2],
    ])
  })

  it('stops before writing anything if the tags cannot be read', async () => {
    const db = makeFakeDb({})
    db._failNext('select', 'tags', { message: 'boom' })

    await expect(install(db)).rejects.toMatchObject({ message: 'boom' })
    expect(db._tables.pipelines ?? []).toHaveLength(0)
  })
})
