#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as net from 'node:net'
import { checkOwnership } from './owner-gate.js'

const WORKER       = process.env['ROOST_IRC_NICK'] ?? 'unknown'
const SOCK_PATH    = process.env['ROOST_PERM_SOCK'] ?? ''
const ASK_CHANNEL  = process.env['ROOST_ASK_CHANNEL'] ?? ''
const ASK_TARGET   = process.env['ROOST_ASK_TARGET'] ?? process.env['ROOST_PERM_TARGET'] ?? ''
const DATA_DIR     = process.env['ROOST_DATA_DIR'] ?? ''
const SESSION_ID   = process.env['CLAUDE_CODE_SESSION_ID'] ?? ''
const TIMEOUT_SECS = Math.max(10, Number(process.env['ROOST_ASK_TIMEOUT_SECS'] ?? '300'))
// Stay under Claude Code's 600s hook default
const SOCKET_TIMEOUT = Math.min(TIMEOUT_SECS, 570)

// ---- Types ------------------------------------------------------------------

interface Option { label: string; description?: string }
interface Question {
  question: string
  header?: string
  options?: Option[]
  multiSelect?: boolean
}

// ---- Output helpers ---------------------------------------------------------

function passthrough(): never {
  process.exit(0)
}

function allow(questions: Question[], answers: Record<string, string>): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  }) + '\n')
  process.exit(0)
}

function deny(reason: string): never {
  process.stderr.write(`ask-question-hook[${WORKER}]: ${reason}\n`)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n')
  process.exit(0)
}

// ---- Question formatting ----------------------------------------------------

export function formatQuestionsForIRC(questions: Question[]): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const prefix = questions.length > 1 ? `Q${i + 1}: ` : ''
    lines.push(`${prefix}${q.question}`)
    for (const [j, o] of (q.options ?? []).entries()) {
      const desc = o.description ? ` — ${o.description}` : ''
      lines.push(`  ${j + 1}. ${o.label}${desc}`)
    }
    if (q.multiSelect) lines.push('  (multi-select: comma-separate multiple choices)')
  })
  if (questions.length > 1) {
    lines.push('Reply: one answer per question, comma-separated (e.g. 1, 2)')
  } else {
    lines.push('Reply: number or option label')
  }
  return lines.join('\n')
}

// ---- Reply parsing ----------------------------------------------------------

export function mapOneReply(raw: string, q: Question): string {
  const opts = q.options ?? []
  if (opts.length === 0) return raw.trim()
  const stripped = raw.trim()
  const num = parseInt(stripped, 10)
  if (!isNaN(num) && num >= 1 && num <= opts.length) return opts[num - 1].label
  const found = opts.find(o => o.label.toLowerCase() === stripped.toLowerCase())
  return found ? found.label : stripped
}

export function mapReplyToAnswers(reply: string, questions: Question[]): Record<string, string> {
  const answers: Record<string, string> = {}
  if (questions.length === 1) {
    const q = questions[0]
    if (q.multiSelect) {
      const parts = reply.split(',').map(p => mapOneReply(p.trim(), q))
      answers[q.question] = parts.join(',')
    } else {
      answers[q.question] = mapOneReply(reply, q)
    }
    return answers
  }
  // Multiple questions: split on comma, one answer per question
  const parts = reply.split(',')
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const raw = (parts[i] ?? '').trim()
    // Strip leading "QN:" or "N." prefix that operators might add
    const body = raw.replace(/^(Q?\d+[.:\s]+)/, '').trim() || raw
    if (q.multiSelect) {
      // Multi-select within multi-question: "/" separates inner choices
      const inner = body.split('/').map(p => mapOneReply(p.trim(), q))
      answers[q.question] = inner.join(',')
    } else {
      answers[q.question] = mapOneReply(body, q)
    }
  }
  return answers
}

// ---- Socket round-trip to permbot -------------------------------------------

export async function askPermbot(summary: string): Promise<string | null> {
  if (!SOCK_PATH || !fs.existsSync(SOCK_PATH)) {
    process.stderr.write(`ask-question-hook[${WORKER}]: ROOST_PERM_SOCK not set or socket missing\n`)
    return null
  }
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCK_PATH)
    sock.setTimeout(SOCKET_TIMEOUT * 1000)
    let buf = ''
    sock.on('connect', () => {
      const req: Record<string, unknown> = {
        summary,
        timeout: SOCKET_TIMEOUT,
        channel: ASK_CHANNEL,
      }
      if (ASK_TARGET) req.replyTarget = ASK_TARGET
      sock.write(JSON.stringify(req) + '\n')
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (!buf.includes('\n')) return
      const line = buf.split('\n')[0]
      sock.destroy()
      try {
        const resp = JSON.parse(line) as Record<string, unknown>
        if (resp['timeout']) { resolve(null); return }
        if (resp['error']) {
          process.stderr.write(`ask-question-hook[${WORKER}]: daemon error: ${resp['error']}\n`)
          resolve(null); return
        }
        resolve(String(resp['reply'] ?? ''))
      } catch (e) {
        process.stderr.write(`ask-question-hook[${WORKER}]: bad daemon response: ${e}\n`)
        resolve(null)
      }
    })
    sock.on('timeout', () => { sock.destroy(); resolve(null) })
    sock.on('error', (e) => {
      process.stderr.write(`ask-question-hook[${WORKER}]: connect ${SOCK_PATH} failed: ${e}\n`)
      resolve(null)
    })
  })
}

// ---- Entrypoint -------------------------------------------------------------

if (import.meta.main) {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
  } catch (e) {
    process.stderr.write(`ask-question-hook[${WORKER}]: bad stdin JSON: ${e}\n`)
    passthrough()
  }

  const toolName = String(payload!['tool_name'] ?? '')
  if (toolName !== 'AskUserQuestion') passthrough()

  // Owner gate: nested claudes inherit ROOST_DATA_DIR and would route through
  // the owner's permbot. Fall through to UI for non-owner sessions.
  if (DATA_DIR && SESSION_ID) {
    const ownership = checkOwnership(DATA_DIR, SESSION_ID)
    if (ownership === 'passive') passthrough()
  }

  const toolInput = (payload!['tool_input'] as Record<string, unknown> | null) ?? {}
  const questions = (toolInput['questions'] as Question[] | undefined) ?? []
  if (questions.length === 0) passthrough()

  if (!SOCK_PATH || !ASK_CHANNEL) {
    process.stderr.write(`ask-question-hook[${WORKER}]: not configured (missing ROOST_PERM_SOCK or ROOST_ASK_CHANNEL), falling through to UI\n`)
    passthrough()
  }

  const summary = formatQuestionsForIRC(questions)
  const reply = await askPermbot(summary)

  if (reply === null) {
    deny(`No IRC reply within ${TIMEOUT_SECS}s — permbot unavailable or timed out. Decide without user input or retry.`)
  }

  const answers = mapReplyToAnswers(reply!, questions)
  allow(questions, answers)
}
