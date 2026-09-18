import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as controlChrome from '../src/index.js'

const readSkill = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n')

async function installSettings(ctx: Context, resolved: Record<string, unknown> = {}): Promise<void> {
  const settings = {
    register(_namespace: string, _schema: unknown, options: { base?: Record<string, unknown> }) {
      return {
        get: () => ({ ...options.base, ...resolved }),
        watch: () => () => {},
      }
    },
  }
  await ctx.plugin({
    name: 'test-settings-service',
    apply(context) {
      context.provide('settings', settings as never)
    },
  })
}

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

  it('registers the fixed progressive facade from plugin startup without raw schemas', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await installSettings(ctx)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false, exposureMode: 'progressive' })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    const names = tools.schemas().map(schema => schema.name)
    expect(names).toEqual([...controlChrome.PROGRESSIVE_BROWSER_TOOL_NAMES])
    expect(names).not.toEqual(expect.arrayContaining(controlChrome.BROWSER_TOOL_NAMES))
    await fiber.dispose()
    expect(tools.schemas()).toHaveLength(0)
  })

  it('waits for delayed settings instead of permanently capturing lazy-full', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    expect(tools.schemas()).toHaveLength(0)
    await installSettings(ctx, { exposureMode: 'progressive' })
    expect(tools.schemas().map(schema => schema.name)).toEqual([...controlChrome.PROGRESSIVE_BROWSER_TOOL_NAMES])
    await fiber.dispose()
    expect(tools.schemas()).toHaveLength(0)
  })

  it('uses the resolved settings section before choosing the progressive catalog', async () => {
    const settings = {
      register(_namespace: string, _schema: unknown, options: { base?: Record<string, unknown> }) {
        return {
          get: () => ({ ...options.base, exposureMode: 'progressive' }),
          watch: () => () => {},
        }
      },
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin({
      name: 'test-settings-service',
      apply(context) {
        context.provide('settings', settings as never)
      },
    })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(controlChrome) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { autoStartBridge: false })
    const tools = ctx.get('tools') as { schemas(): readonly { name: string }[] }
    expect(tools.schemas().map(schema => schema.name)).toEqual([...controlChrome.PROGRESSIVE_BROWSER_TOOL_NAMES])
    await fiber.dispose()
  })

  it('registers and lazily loads the bundled Skill when the provider service is present', async () => {
    type SkillProvider = {
      name: string
      list(options: { signal?: AbortSignal }): Promise<readonly Record<string, unknown>[]>
      get(candidate: Record<string, unknown>, options: { signal?: AbortSignal }): Promise<Record<string, unknown> | undefined>
    }
    const providers: SkillProvider[] = []
    const skillService: {
      providers: SkillProvider[]
      registerProvider(this: { providers: SkillProvider[] }, create: (control: { signal: AbortSignal }) => SkillProvider): () => void
    } = {
      providers,
      registerProvider(create) {
        this.providers.push(create({ signal: new AbortController().signal }))
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
    expect(providers).toHaveLength(1)
    const provider = providers[0]
    expect(provider).toBeDefined()
    const candidates = await provider!.list({})
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'pi-control-chrome',
      description: 'Control the user\'s existing Chrome or Edge profile through pi-control-chrome browser tools and the local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.',
      whenToUse: 'Only when the user explicitly requests control of the existing Chrome or Edge browser.',
      source: 'bundled',
      provider: 'control-chrome-bundled',
      rank: 600,
      resourceBase: {
        kind: 'directory',
        path: expect.stringContaining('dsh-tool-control-chrome'),
      },
      metadata: {
        compatibility: expect.stringContaining('pi-control-chrome browser tools'),
      },
    })
    const definition = await provider!.get(candidates[0]!, {})
    expect(definition).toMatchObject({
      name: 'pi-control-chrome',
      description: 'Control the user\'s existing Chrome or Edge profile through pi-control-chrome browser tools and the local Bridge. Use for browser tabs, logged-in sessions, page inspection, interaction, screenshots, uploads, downloads, dialogs, clipboard, console/network/CDP, tab handoff or cleanup, and diagnosing Bridge, extension, browser-target, or stale-handle problems.',
      whenToUse: 'Only when the user explicitly requests control of the existing Chrome or Edge browser.',
      content: expect.stringContaining('# pi-control-chrome'),
      source: 'bundled',
      provider: 'control-chrome-bundled',
      metadata: {
        compatibility: expect.stringContaining('pi-control-chrome browser tools'),
      },
    })
    expect(definition?.content).toBe(controlChrome.BROWSER_SKILL_CONTENT)
    expect(definition?.content).not.toMatch(/^---/u)
    expect(definition?.content).not.toContain('/chrome group')
    expect(definition?.content).not.toContain('/chrome cleanup')
    await fiber.dispose()
  })

  it('keeps the Pi and DSH Skill copies and references identical', () => {
    const testRoot = fileURLToPath(new URL('.', import.meta.url))
    const piSkill = resolve(testRoot, '../../skills/pi-control-chrome')
    const dshSkill = resolve(testRoot, '../skills/pi-control-chrome')
    for (const relative of ['SKILL.md', 'references/recovery.md', 'references/workflows.md']) {
      expect(readSkill(resolve(dshSkill, relative))).toBe(readSkill(resolve(piSkill, relative)))
    }
  })

  it('falls back to runtime registration for legacy Skill services', async () => {
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
      name: 'legacy-skill-service',
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
    await installSettings(ctx)
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
