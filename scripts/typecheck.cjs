const { spawnSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const result = spawnSync(
    process.execPath,
    [tsc, '-p', path.join(root, 'tsconfig.json'), '--noEmit', '--pretty', 'false'],
    {
        cwd: root,
        stdio: 'inherit',
        env: process.env
    }
)

process.exit(result.status ?? 1)
