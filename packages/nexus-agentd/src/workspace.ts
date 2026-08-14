import { realpath } from 'node:fs/promises'
import path from 'node:path'

export class WorkspacePolicy {
    private constructor(private readonly roots: string[]) {}

    static async create(configuredRoots: string[]) {
        const roots = await Promise.all(
            configuredRoots.map(async (root) => normalize(await realpath(root)))
        )
        return new WorkspacePolicy(Array.from(new Set(roots)))
    }

    async resolve(input: string) {
        if (!input?.trim()) throw new Error('workspace is required')
        const candidate = normalize(await realpath(input))
        const allowed = this.roots.some((root) => isWithin(root, candidate))
        if (!allowed) throw new Error(`workspace is outside the configured allowlist: ${input}`)
        return candidate
    }

    listRoots() {
        return [...this.roots]
    }
}

function isWithin(root: string, candidate: string) {
    const relative = path.relative(root, candidate)
    return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
    )
}

function normalize(value: string) {
    return path.resolve(value)
}
