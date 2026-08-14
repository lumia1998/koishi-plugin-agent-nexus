import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileManagedDelegationAgents } from '../src/agentd/managed.ts'
import type { DelegationAgentConfig } from '../src/types.ts'

test('reconciles auto-managed gateway routes without changing custom routes', () => {
    const current: DelegationAgentConfig[] = [
        {
            id: 'managed-opencode',
            name: 'Custom OpenCode name',
            enabled: false,
            provider: 'gateway',
            remoteId: 'old-gateway',
            agentId: 'opencode',
            workspace: '/old/projects/app',
            managedHostId: 'host-1'
        },
        {
            id: 'managed-codex',
            name: 'Codex',
            enabled: true,
            provider: 'gateway',
            remoteId: 'old-gateway',
            agentId: 'codex',
            workspace: '/old/projects',
            managedHostId: 'host-1'
        },
        {
            id: 'custom-pi',
            name: 'Project Pi',
            enabled: true,
            provider: 'gateway',
            remoteId: 'gateway-1',
            agentId: 'pi',
            workspace: '/new/projects/pi'
        }
    ]

    const result = reconcileManagedDelegationAgents(current, {
        hostId: 'host-1',
        hostName: 'dev',
        gatewayId: 'gateway-1',
        agents: ['opencode', 'pi', 'claude'],
        workspaceRoots: ['/new/projects'],
        createMissing: true
    })

    assert.equal(result.some((agent) => agent.id === 'managed-codex'), false)
    assert.equal(result.filter((agent) => agent.agentId === 'pi').length, 1)
    assert.deepEqual(
        result.find((agent) => agent.id === 'managed-opencode'),
        {
            ...current[0],
            remoteId: 'gateway-1',
            workspace: '/new/projects'
        }
    )
    const claude = result.find((agent) => agent.agentId === 'claude')
    assert.equal(claude?.managedHostId, 'host-1')
    assert.equal(claude?.workspace, '/new/projects')
})

test('keeps a managed project workspace when it remains in the allowlist', () => {
    const result = reconcileManagedDelegationAgents(
        [
            {
                id: 'managed-opencode',
                name: 'OpenCode',
                enabled: true,
                provider: 'gateway',
                remoteId: 'gateway-1',
                agentId: 'opencode',
                workspace: '/repos/project-a',
                managedHostId: 'host-1'
            }
        ],
        {
            hostId: 'host-1',
            hostName: 'dev',
            gatewayId: 'gateway-1',
            agents: ['opencode'],
            workspaceRoots: ['/repos'],
            createMissing: true
        }
    )
    assert.equal(result[0].workspace, '/repos/project-a')
})
