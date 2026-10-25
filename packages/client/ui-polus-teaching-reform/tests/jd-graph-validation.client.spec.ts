import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { graphNodes } from '../src/jd/document.ts'
import { JdGraphValidationError } from '../src/jd/validation.ts'
import { graphFixture, projectFixture } from './jd-fixture.client.ts'

test('an expanded description identifies the unsupported field and preserves the literal original', () => {
  const project = projectFixture(), nodes = graphFixture(), source = project.sources[0]!
  const quote = '参与线上问题排查，修复各种环境问题'
  source.body += '\n' + quote
  source.content_hash = createHash('sha256').update(source.body).digest('hex')
  Object.assign(nodes[0]!, { title: '修复各种环境问题', description: '在测试与生产环境中定位并修复因环境差异导致的问题',
    basis: 'direct', evidence: [{ jd_id: source.id, quote }] })
  const original = structuredClone({ project, nodes })
  try {
    graphNodes({ nodes }, project.sources)
    expect.fail('The expanded description cannot be accepted as a direct quotation')
  } catch (error) {
    expect(error).toBeInstanceOf(JdGraphValidationError)
    expect((error as JdGraphValidationError).issues).toMatchObject([
      { code: 'unsupported_direct', node: nodes[0], fields: ['description'] },
    ])
  }
  expect({ project, nodes }).toEqual(original)
})

test('a wrong parent and an incomplete branch both retain the nodes requiring model correction', () => {
  const nodes = graphFixture().slice(0, -1)
  nodes[2]!.parent_id = nodes[0]!.id
  try {
    graphNodes({ nodes }, projectFixture().sources)
    expect.fail('Invalid parent and missing knowledge must reject the graph')
  } catch (error) {
    expect(error).toBeInstanceOf(JdGraphValidationError)
    const issues = (error as JdGraphValidationError).issues
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid_parent', node: nodes[2], expected_parent_kind: 'task' }))
    expect(issues).toContainEqual(expect.objectContaining({ code: 'incomplete_branch', node: nodes[3], expected_child_kind: 'knowledge' }))
  }
})
