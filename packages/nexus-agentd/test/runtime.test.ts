import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpProcessRuntime } from '../src/acp/runtime.js'

test('permission requests remain pending after invalid input and accept an option', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    const response = (runtime as any).requestPermission({
        toolCall: {
            toolCallId: 'tool-1',
            title: 'Write package.json'
        },
        options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
        ]
    })
    assert.equal(sink.state, 'permission_required')
    assert.equal(sink.pendingRequest?.options?.[0].id, 'allow')
    await assert.rejects(() => runtime.respondPending('not-an-option'), /option id\/name/)
    assert.equal(sink.state, 'permission_required')
    assert.equal(sink.pendingRequest?.id, (runtime as any).pending.request.id)

    await runtime.respondPending('1')
    assert.deepEqual(await response, {
        outcome: { outcome: 'selected', optionId: 'allow' }
    })
    assert.equal(sink.state, 'running')
    assert.equal(sink.pendingRequest, undefined)
})

test('a canceled prompt cannot overwrite the terminal canceled state', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    let finish!: (value: unknown) => void
    ;(runtime as any).connection = {
        agent: {
            request: () => new Promise((resolve) => {
                finish = resolve
            })
        }
    }
    const prompt = runtime.prompt('Work')
    await Promise.resolve()
    sink.setState('canceled')
    finish({ stopReason: 'end_turn' })
    await prompt
    assert.equal(sink.state, 'canceled')
    assert.equal(sink.states.includes('completed'), false)
})

test('cancel remains terminal when the ACP notification fails', async () => {
    const sink = createSink()
    sink.state = 'running'
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    let closed = false
    ;(runtime as any).connection = {
        agent: {
            async notify() {
                throw new Error('connection closed')
            }
        },
        close() {
            closed = true
        }
    }
    await runtime.cancel()
    assert.equal(sink.state, 'canceled')
    assert.equal(closed, true)
    assert.match(String(sink.events[0]?.data?.text), /connection closed/)
})

function driver() {
    return {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        args: ['acp'],
        env: {},
        permissionPolicy: 'ask' as const,
        permissionTimeoutMs: 1000,
        async probe() {
            throw new Error('not used')
        },
        spawn() {
            throw new Error('not used')
        }
    }
}

function createSink() {
    return {
        state: 'created' as string,
        acpSessionId: 'acp-1',
        pendingRequest: undefined as any,
        states: [] as string[],
        events: [] as Array<{ type: string; data: any }>,
        setAcpSessionId(id: string) {
            this.acpSessionId = id
        },
        setState(state: string) {
            this.state = state
            this.states.push(state)
        },
        appendOutput() {},
        setPending(request: any) {
            this.pendingRequest = structuredClone(request)
            this.setState(request.kind === 'permission' ? 'permission_required' : 'input_required')
        },
        clearPending() {
            this.pendingRequest = undefined
        },
        emit(type: string, data?: unknown) {
            this.events.push({ type, data })
        }
    }
}
