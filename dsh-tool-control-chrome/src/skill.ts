/** Bundled DSH Skill metadata and provider for pi-control-chrome. */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'

const BUNDLED_SKILL_PROVIDER_NAME = 'control-chrome-bundled'
// Mirrors @deepseek-ai/dsh-skill's BUNDLED_SKILL_RANK; lower ranks are higher priority.
const BUNDLED_SKILL_RANK = 600
const SKILL_BODY_URL = new URL('../skills/pi-control-chrome/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/pi-control-chrome/', import.meta.url)),
} as const
const FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
])

interface SkillInvocation {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

interface SkillCandidate {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocation
  readonly provider: string
  readonly source: string
  readonly resourceBase: typeof RESOURCE_BASE
  readonly rank: number
  readonly locator: URL
  readonly metadata?: Readonly<Record<string, unknown>>
}

type SkillDefinition = Omit<SkillCandidate, 'rank' | 'locator'> & {
  readonly content: string
}

interface SkillProvider {
  readonly name: string
  readonly list: () => Promise<readonly SkillCandidate[]>
  readonly get: (candidate: SkillCandidate) => Promise<SkillDefinition>
}

interface RuntimeSkillRegistration {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly content: string
  readonly invocation: SkillInvocation
  readonly metadata?: Readonly<Record<string, unknown>>
}

interface SkillService {
  readonly registerProvider?: (create: () => SkillProvider) => () => void
  readonly register?: (skill: RuntimeSkillRegistration) => () => void
}

interface ParsedSkillDocument {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocation
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly content: string
}

const BROWSER_SKILL_DOCUMENT = parseSkillDocument(readFileSync(SKILL_BODY_URL, 'utf8'))

/** Stable Skill name used to activate the browser tool catalog. */
export const BROWSER_SKILL_NAME = BROWSER_SKILL_DOCUMENT.name

/** Description used in the DSH Skill catalog. */
export const BROWSER_SKILL_DESCRIPTION = BROWSER_SKILL_DOCUMENT.description

/**
 * @deprecated This compatibility export reads the bundled Skill body eagerly.
 * The provider itself reloads the Markdown body when the Skill is requested.
 */
export const BROWSER_SKILL_CONTENT = BROWSER_SKILL_DOCUMENT.content

const CANDIDATE = toCandidate(BROWSER_SKILL_DOCUMENT)

const provider: SkillProvider = {
  name: BUNDLED_SKILL_PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return toDefinition(await readBundledSkillDocument())
  },
}

/** Register the bundled Skill, with a runtime fallback for older Skill services. */
export function registerBrowserSkill(ctx: Context): void {
  const skills = ctx.get('skills') as SkillService | undefined
  if (skills === undefined) return
  if (typeof skills.registerProvider === 'function') {
    skills.registerProvider(() => provider)
    return
  }
  if (typeof skills.register === 'function') {
    skills.register({
      name: BROWSER_SKILL_DOCUMENT.name,
      description: BROWSER_SKILL_DOCUMENT.description,
      ...BROWSER_SKILL_DOCUMENT.whenToUse === undefined ? {} : { whenToUse: BROWSER_SKILL_DOCUMENT.whenToUse },
      source: 'runtime',
      content: BROWSER_SKILL_DOCUMENT.content,
      invocation: BROWSER_SKILL_DOCUMENT.invocation,
      ...BROWSER_SKILL_DOCUMENT.metadata === undefined ? {} : { metadata: BROWSER_SKILL_DOCUMENT.metadata },
    })
  }
}

function toCandidate(document: ParsedSkillDocument): SkillCandidate {
  return {
    name: document.name,
    description: document.description,
    ...document.whenToUse === undefined ? {} : { whenToUse: document.whenToUse },
    invocation: document.invocation,
    provider: BUNDLED_SKILL_PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_BODY_URL,
    ...document.metadata === undefined ? {} : { metadata: document.metadata },
  }
}

function toDefinition(document: ParsedSkillDocument): SkillDefinition {
  return {
    name: document.name,
    description: document.description,
    ...document.whenToUse === undefined ? {} : { whenToUse: document.whenToUse },
    invocation: document.invocation,
    provider: BUNDLED_SKILL_PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    ...document.metadata === undefined ? {} : { metadata: document.metadata },
    content: document.content,
  }
}

async function readBundledSkillDocument(): Promise<ParsedSkillDocument> {
  return parseSkillDocument(await readFile(SKILL_BODY_URL, 'utf8'))
}

function parseSkillDocument(document: string): ParsedSkillDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(document)
  if (match === null || match[1] === undefined) {
    throw new Error(`Bundled Skill is missing YAML frontmatter: ${SKILL_BODY_URL.href}`)
  }
  const frontmatter = parseYaml(match[1])
  if (!isRecord(frontmatter)) throw new Error(`Bundled Skill frontmatter must be a mapping: ${SKILL_BODY_URL.href}`)
  const name = requiredString(frontmatter.name, 'name')
  const description = requiredString(frontmatter.description, 'description')
  const whenToUse = optionalString(frontmatter.whenToUse, 'whenToUse')
  const metadataEntries = Object.entries(frontmatter).filter(([key]) => !FRONTMATTER_FIELDS.has(key))
  const metadata = metadataEntries.length === 0 ? undefined : Object.fromEntries(metadataEntries)
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: {
      modelInvocable: !optionalBoolean(frontmatter['disable-model-invocation'], 'disable-model-invocation', false),
      userInvocable: optionalBoolean(frontmatter['user-invocable'], 'user-invocable', true),
    },
    ...metadata === undefined ? {} : { metadata },
    content: readSkillBody(document),
  }
}

function readSkillBody(document: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(document)
  return (frontmatter === null ? document : document.slice(frontmatter[0].length)).trim()
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Bundled Skill ${field} must be a non-empty string: ${SKILL_BODY_URL.href}`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field)
}

function optionalBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') throw new Error(`Bundled Skill ${field} must be a boolean: ${SKILL_BODY_URL.href}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
