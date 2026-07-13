const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function toDriveRoot(input) {
    const abs = path.resolve(input)
    const m = abs.match(/^[\\/]{2}[^\\/]+[\\/]code_workspace[\\/]?(.*)$/i)
    if (m) {
        for (const drive of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
            const mapped = path.resolve(`${drive}:\\` + (m[1] || ''))
            if (
                fs.existsSync(path.join(mapped, 'package.json')) &&
                fs.existsSync(path.join(mapped, 'src', 'index.ts'))
            ) {
                return mapped
            }
        }
    }
    return abs
}

function resolveRoot() {
    const candidates = [
        process.env.INIT_CWD,
        process.cwd(),
        path.resolve(__dirname, '..')
    ].filter(Boolean)
    for (const candidate of candidates) {
        const abs = toDriveRoot(candidate)
        if (
            fs.existsSync(path.join(abs, 'package.json')) &&
            fs.existsSync(path.join(abs, 'src', 'index.ts'))
        ) {
            return abs
        }
    }
    return toDriveRoot(path.resolve(__dirname, '..'))
}

const root = resolveRoot()
process.chdir(root)
console.log('backend root:', root)
const outdir = path.join(root, 'lib')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

fs.rmSync(outdir, { recursive: true, force: true })
fs.mkdirSync(outdir, { recursive: true })

esbuild
    .build({
        entryPoints: [path.join(root, 'src/index.ts')],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile: path.join(outdir, 'index.js'),
        external: [
            'koishi',
            'ssh2',
            '@langchain/core',
            'zod',
            'ws',
            '@koishijs/plugin-console',
            'koishi-plugin-chatluna',
            'koishi-plugin-chatluna-storage-service'
        ],
        logLevel: 'info'
    })
    .then(() => {
        const result = spawnSync(
            process.execPath,
            [
                tsc,
                '-p',
                path.join(root, 'tsconfig.json'),
                '--emitDeclarationOnly',
                '--pretty',
                'false'
            ],
            {
                cwd: root,
                stdio: 'inherit',
                env: process.env
            }
        )
        if ((result.status ?? 1) !== 0) {
            process.exit(result.status ?? 1)
        }

        const client = spawnSync(
            process.execPath,
            [path.join(root, 'scripts', 'build-client.cjs')],
            {
                cwd: root,
                stdio: 'inherit',
                env: process.env
            }
        )
        if ((client.status ?? 1) !== 0) {
            process.exit(client.status ?? 1)
        }
        console.log('build ok')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
