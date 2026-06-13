#!/usr/bin/env node
// Agent app tool — drive the dockerized bot (backend + frontend) for an agent.
// Thin, predictable wrapper over `docker compose` plus the backend type-check.
// All output streams straight through so the agent sees real results.

import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, cwd = REPO) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  } catch (e) {
    process.exit(e.status ?? 1)
  }
}
const compose = (...args) => run('docker', ['compose', ...args])

const HELP = `Agent app tool — manage the dockerized bot.

Usage: node tools/app.mjs <command> [args]

  status                 Show container status (docker compose ps)
  logs [service] [N]     Tail last N lines (default 100) of a service (default backend)
  follow [service]       Stream live logs (Ctrl-C to stop)
  start [service]        Start stopped container(s) (default backend)
  stop [service]         Stop container(s) (default backend)
  restart [service]      Restart container(s) (default backend)
  up                     Build images and start all in the background
  down                   Stop and remove all containers
  lint                   Backend type-check (cd backend && npm run lint)

Services: backend, frontend
`

const svc = (a, def) => (a && !/^\d+$/.test(a) ? a : def)

const [cmd, a1, a2] = process.argv.slice(2)
switch (cmd) {
  case undefined: case 'help': case '--help': case '-h': console.log(HELP); break
  case 'status': case 'ps': compose('ps'); break
  case 'logs': {
    const service = svc(a1, 'backend')
    const tail = /^\d+$/.test(a1) ? a1 : (/^\d+$/.test(a2) ? a2 : '100')
    compose('logs', '--tail', tail, service); break
  }
  case 'follow': compose('logs', '-f', '--tail', '50', svc(a1, 'backend')); break
  case 'start': compose('start', svc(a1, 'backend')); break
  case 'stop': compose('stop', svc(a1, 'backend')); break
  case 'restart': compose('restart', svc(a1, 'backend')); break
  case 'up': compose('up', '-d', '--build'); break
  case 'down': compose('down'); break
  case 'lint': run('npm', ['run', 'lint'], path.join(REPO, 'backend')); break
  default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2)
}
