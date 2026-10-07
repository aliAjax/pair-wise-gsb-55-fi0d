// 使用 esbuild 将 TS 校验脚本打包为 CJS 后在 Node 中执行（纯领域/状态逻辑，不依赖浏览器）
import { build } from 'esbuild'
import path from 'node:path'

const alias = {
  name: 'ts-alias',
  setup(bundler) {
    bundler.onResolve({ filter: /^@\// }, (args) => ({
      path: path.resolve('src', `${args.path.slice(2)}.ts`),
    }))
  },
}

const scripts = ['verify-domain', 'verify-store']

for (const name of scripts) {
  const outfile = path.join('/tmp', `${name}.cjs`)
  await build({
    entryPoints: [`scripts/${name}.ts`],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [alias],
    logLevel: 'silent',
  })
  process.stdout.write(`\n=== ${name} ===\n`)
  await import(`file://${outfile}?t=${Date.now()}`)
}
