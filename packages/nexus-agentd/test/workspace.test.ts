import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspacePolicy } from '../src/workspace.js'

test('workspace policy accepts descendants and rejects traversal/outside paths', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-workspace-'))
    const root = path.join(directory, 'allowed')
    const project = path.join(root, 'project')
    const outside = path.join(directory, 'outside')
    await mkdir(project, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
        const policy = await WorkspacePolicy.create([root])
        assert.equal(await policy.resolve(project), normalize(project))
        await assert.rejects(() => policy.resolve(outside), /outside the configured allowlist/)
        await assert.rejects(
            () => policy.resolve(path.join(project, '..', '..', 'outside')),
            /outside the configured allowlist/
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('workspace policy rejects symlink escapes', { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-symlink-'))
    const root = path.join(directory, 'allowed')
    const outside = path.join(directory, 'outside')
    const link = path.join(root, 'escape')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
        try {
            await symlink(outside, link, 'dir')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('symlink creation is not permitted')
                return
            }
            throw error
        }
        const policy = await WorkspacePolicy.create([root])
        await assert.rejects(() => policy.resolve(link), /outside the configured allowlist/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

function normalize(value: string) {
    return path.resolve(value)
}
