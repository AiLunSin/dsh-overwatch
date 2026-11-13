import { setTimeout as delay } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { FileLock } from '../../src/util.js'

const [dir, results, index] = process.argv.slice(2)
const lock = new FileLock({ dir, name: 'watch', waitMs: 0 })
try {
  await lock.acquire()
  writeFileSync(path.join(results, 'winner.txt'), `winner:${index}\n`, 'utf8')
  await delay(700)
  lock.release()
  process.exit(0)
} catch (error) {
  if (error?.code === 'ELOCKED') process.exit(3)
  console.error(error)
  process.exit(1)
}
