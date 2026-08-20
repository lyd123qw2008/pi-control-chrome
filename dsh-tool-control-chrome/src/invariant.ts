/** Package-owned invariant companion for the DSH browser-control tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@lyd123qw2008/dsh-tool-control-chrome'

/** Cordis companion plugin name. */
export const name = 'tool-control-chrome-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: browser ownership is authoritative in the extension's
 * storage and the package does not own a durable DSH event or data relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's empty invariant companion.
 *
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
