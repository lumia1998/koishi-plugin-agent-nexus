import 'koishi'
import type {} from '@koishijs/plugin-console'

declare module 'koishi-plugin-chatluna-storage-service'

declare module 'koishi' {
    interface Context {
        chatluna?: any
        chatluna_storage: {
            createTempFileFromStream(
                stream: NodeJS.ReadableStream,
                name: string,
                options?: { mimeType?: string; size?: number }
            ): Promise<{ url: string; name: string }>
        }
        server?: {
            ws(
                path: RegExp | string,
                callback: (socket: any, request: any) => void
            ): { close(): void }
        }
    }
}
