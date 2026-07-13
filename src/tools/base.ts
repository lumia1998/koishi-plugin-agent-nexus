import { StructuredTool } from '@langchain/core/tools'
import type { AgentNexusService } from '../service'

// LangChain's generic defaults can explode under TS 5.9; keep tools untyped here.
export abstract class NexusToolBase extends (StructuredTool as any) {
    constructor(protected readonly nexus: AgentNexusService) {
        super()
    }

    protected formatError(err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `Error: ${msg}`
    }
}
