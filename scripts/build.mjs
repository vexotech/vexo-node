// Writes index.js, the CommonJS build of index.mjs, for require('vexo-node'). npm test and npm pack run it.
import { readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const exported = /^export class Vexo /m
if (!exported.test(source) || /^(import|export) /m.test(source.replace(exported, ''))) {
  throw new Error('index.mjs must import nothing and export only `class Vexo`')
}
writeFileSync(new URL('../index.js', import.meta.url), "'use strict'\n" +
  '// Generated from index.mjs by `npm run build`. Edit index.mjs, not this file.\n\n' +
  source.replace(exported, 'class Vexo ') + '\nmodule.exports = { Vexo }\n')
