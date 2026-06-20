// One-off helper to provision auth credentials for the gateway.
//
//   npm run auth:hash -- 'my-strong-password'
//
// Prints the .env lines to paste in: a scrypt AUTH_PASSWORD_HASH (so the
// plaintext never lives in .env) and a fresh random AUTH_SECRET. If no password
// is given on the argv, it's read interactively from stdin (no echo).
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { hashPassword } from '../src/auth/password.js'

async function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // Mute echo while typing the password.
  const out = process.stdout
  const origWrite = out.write.bind(out)
  let muted = false
  ;(out as unknown as { write: typeof origWrite }).write = ((chunk: string, ...args: unknown[]) =>
    muted ? true : origWrite(chunk, ...(args as []))) as typeof origWrite
  process.stdout.write(prompt)
  muted = true
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      muted = false
      ;(out as unknown as { write: typeof origWrite }).write = origWrite
      process.stdout.write('\n')
      rl.close()
      resolve(answer)
    })
  })
}

async function main(): Promise<void> {
  const password = process.argv[2] ?? (await readHidden('New password: '))
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.')
    process.exit(1)
  }
  const hash = hashPassword(password)
  const secret = randomBytes(48).toString('hex')
  console.log('\nAdd these to your .env (do NOT commit it):\n')
  console.log(`AUTH_PASSWORD_HASH=${hash}`)
  console.log(`AUTH_SECRET=${secret}`)
  console.log('\n# Optional: AUTH_USERNAME=admin  AUTH_TOKEN_TTL_MINUTES=720')
  console.log('# Auth turns on automatically once AUTH_PASSWORD_HASH is set.')
}

void main()
