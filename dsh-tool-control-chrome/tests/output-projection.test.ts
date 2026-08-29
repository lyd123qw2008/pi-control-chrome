import { describe, expect, it } from 'vitest'
import {
  compactAccessibilityResult,
  compactBrowserResult,
  compactDomCuaResult,
  compactSnapshotResult,
  compactTabsResult,
} from '../src/output.js'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected record')
  return value as Record<string, unknown>
}

describe('browser output projections', () => {
  it('projects snapshot to one bounded state and keeps refs', () => {
    const result = record(compactSnapshotResult({
      tabId: 1,
      tab: { id: 1, title: 'Orders', url: 'https://example.test/orders', favicon: `data:image/png;base64,${'A'.repeat(1000)}` },
      frameTree: { huge: 'debug-only' },
      snapshot: {
        snapshotId: 'snapshot-1',
        title: 'Orders',
        url: 'https://example.test/orders',
        text: 'page body',
        elements: [{ ref: 'e1', role: 'button', name: 'Submit' }],
        accessibility: { children: [{ role: 'generic', name: 'duplicate' }] },
      },
    }))
    const snapshot = record(result.snapshot)
    expect(snapshot.state).toContain('[ref=e1]')
    expect(snapshot.state).toContain('Submit')
    expect(snapshot.elements).toBeUndefined()
    expect(snapshot.accessibility).toBeUndefined()
    expect(record(result.tab).favicon).toBeUndefined()
    expect(result.frameTree).toBeUndefined()
  })

  it('avoids repeating page text when interactive refs already describe the page', () => {
    const result = record(compactSnapshotResult({
      tab: { id: 1, title: 'Orders', url: 'https://example.test/orders' },
      snapshot: {
        snapshotId: 'snapshot-compact',
        title: 'Orders',
        url: 'https://example.test/orders',
        text: 'This long text is available through browser_extract.',
        elements: [
          { ref: 'e1', role: 'button', name: 'Submit', value: '' },
          { ref: 'e2', role: 'textbox', name: 'Search', value: 'orders' },
        ],
      },
    }))
    const snapshot = record(result.snapshot)
    expect(snapshot.state).toContain('[ref=e1]')
    expect(snapshot.state).toContain('value="orders"')
    expect(snapshot.state).not.toContain('Page text:')
    expect(snapshot.state).not.toContain('available through browser_extract')
    expect(snapshot.title).toBeUndefined()
    expect(snapshot.url).toBeUndefined()
  })

  it('does not mark interactive state truncated when omitted page text is the only limit', () => {
    const result = record(compactSnapshotResult({
      snapshot: {
        snapshotId: 'snapshot-semantic',
        text: 'x'.repeat(30_000),
        textTruncated: true,
        truncated: true,
        elementCharCount: 120,
        elements: [{ ref: 'e1', role: 'button', name: 'Submit' }],
      },
    }))
    expect(record(result.snapshot).truncated).toBe(false)
  })
  it('projects accessibility revisions without exposing the raw tree', () => {
    const result = record(compactAccessibilityResult({
      snapshot: { snapshotId: 'snapshot-2', accessibility: { mode: 'diff', baseSnapshotId: 'snapshot-1', state: '+ button "Save"', nodeCount: 1, changedNodeCount: 1 } },
    }))
    expect(result.mode).toBe('diff')
    expect(result.state).toBe('+ button "Save"')
    expect(result.children).toBeUndefined()
  })

  it('projects visible DOM nodes to bounded lines', () => {
    const result = record(compactDomCuaResult({
      tabId: 1,
      dom: { snapshotId: 'dom-1', nodes: [{ node_id: 'd1', parent_id: undefined, tag: 'button', role: undefined, text: 'Submit' }] },
    }))
    const dom = record(result.dom)
    expect(dom.state).toContain('node_id=d1')
    expect(dom.state).toContain('Submit')
    expect(dom.nodes).toBeUndefined()
  })

  it('projects tab inventories without favicon data', () => {
    const result = record(compactTabsResult({ browserId: 'edge:test', profile: 'profile', tabs: [{ id: 1, title: 'A', url: 'https://example.test', favicon: `data:image/png;base64,${'A'.repeat(1000)}` }] }))
    const tabs = result.tabs as unknown[]
    expect(record(tabs[0]).favicon).toBeUndefined()
  })

  it('bounds a large snapshot state', () => {
    const result = record(compactBrowserResult('browser_snapshot', {}, {
      snapshot: { snapshotId: 'large', title: 'large', url: 'https://example.test', text: 'x'.repeat(30_000), elements: [] },
    }))
    const snapshot = record(result.snapshot)
    expect(String(snapshot.state).length).toBeLessThanOrEqual(20_000)
    expect(snapshot.truncated).toBe(true)
  })
})
