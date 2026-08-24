import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as controlChrome from '../src/index.js'

describe('dsh-tool-control-chrome real load path', () => {
  it('keeps the function-plugin namespace through Loader unwrapping', () => {
    expect('default' in controlChrome).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Record<string, unknown>
    expect(unwrapped).toBe(controlChrome)
    expect(unwrapped.name).toBe('tool-control-chrome')
    expect(unwrapped.inject).toEqual(['tools', 'commands'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('does not publish browser schemas in the default lazy load path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    expect(tools.schemas().map(schema => schema.name)).not.toEqual(expect.arrayContaining(controlChrome.BROWSER_TOOL_NAMES))
    expect(tools.schemas().filter(schema => schema.name.startsWith('browser_'))).toHaveLength(0)
    await fiber.dispose()
    expect(tools.schemas()).toHaveLength(0)
  })

  it('registers canonical Skill metadata when the optional Skill service is present', async () => {
    const registrations: Record<string, unknown>[] = []
    const skillService = {
      register(skill: Record<string, unknown>) {
        registrations.push(skill)
        return () => {}
      },
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin({
      name: 'test-skill-service',
      apply(context) {
        context.provide('skills', skillService)
      },
    })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false })
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: controlChrome.BROWSER_SKILL_NAME,
      description: controlChrome.BROWSER_SKILL_DESCRIPTION,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    await fiber.dispose()
  })

  it('keeps the complete catalog in the explicit eager compatibility path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false, lazyTools: false })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    const names = tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(controlChrome.BROWSER_TOOL_NAMES))
    expect(names).toHaveLength(controlChrome.BROWSER_TOOL_NAMES.length)
    await fiber.dispose()
    expect(tools.schemas()).toHaveLength(0)
  })
})
