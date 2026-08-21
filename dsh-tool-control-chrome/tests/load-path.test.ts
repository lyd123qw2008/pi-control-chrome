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

  it('registers the complete tool catalog through a real Context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
     await ctx.plugin(CommandRuntime)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    const names = tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(controlChrome.BROWSER_TOOL_NAMES))
    expect(names).toHaveLength(controlChrome.BROWSER_TOOL_NAMES.length)
    await fiber.dispose()
    expect(tools.schemas()).toHaveLength(0)
  })
})
