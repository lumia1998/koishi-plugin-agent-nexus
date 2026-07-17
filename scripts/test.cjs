const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nexus-test-'))
const outfile = path.join(outdir, 'index.test.cjs')

try {
    esbuild.buildSync({
        entryPoints: [path.join(root, 'test/index.test.mts')],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: ['ssh2'],
        outfile
    })
    const result = spawnSync(process.execPath, ['--test', outfile], {
        cwd: root,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_PATH: path.join(root, 'node_modules')
        }
    })
    process.exitCode = result.status ?? 1
} finally {
    fs.rmSync(outdir, { recursive: true, force: true })
}
