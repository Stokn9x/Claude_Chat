import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Chat, Message, Room, View } from '../types'

// The project's public URL and publishable key: safe to ship, Row Level
// Security on every table decides what a signed-in person may read or write.
const SUPABASE = 'https://yqdumafjvdyabojuajeo.supabase.co'
const KEY = 'sb_publishable_bDtsNOxE17K2fsPr4vyUWA_QuvoO0du'

const PANE = 'team-chat'
const POLL_MS = 3000
const KEEP = 200

const view = atom(
  { plugin: 'team-chat', key: 'view' } as const,
  { phase: 'signed-out', email: null, error: null, isBusy: false, mode: 'none' } as View,
)
const chat = atom(
  { plugin: 'team-chat', key: 'chat' } as const,
  { me: null, name: null, rooms: [], roomId: null, members: [], messages: [] } as Chat,
)
const draft = atom({ plugin: 'team-chat', key: 'draft' } as const, '')
const lastReply = atom({ plugin: 'team-chat', key: 'lastReply' } as const, null as string | null)

type $ = EngineInterface
type Session = { access_token: string; refresh_token: string; expires_at: number; email: string }

// ─── Small helpers ──────────────────────────────────────────────────────

const nameFrom = (email: string) => {
  const local = email.split('@')[0] ?? email
  const first = local.split(/[._-]/)[0] ?? local

  return first.charAt(0).toUpperCase() + first.slice(1)
}

const clock = (iso: string) => {
  const d = new Date(iso)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const isEmail = (text: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)

const setView = ($: $, patch: Partial<View>) => update($, view, v => ({ ...v, ...patch }))
const setChat = ($: $, patch: Partial<Chat>) => update($, chat, c => ({ ...c, ...patch }))

const fail = ($: $, error: string) => setView($, { error, isBusy: false })

// ─── Supabase over the host's HTTP ──────────────────────────────────────

type Call = { method?: string; body?: unknown; token?: string; prefer?: string }

const call = async <T,>($: $, path: string, init: Call = {}): Promise<{ ok: boolean; status: number; data: T | null; message: string }> => {
  const headers: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.prefer) headers.Prefer = init.prefer

  const res = await $.http.fetch(`${SUPABASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  let data: unknown = null
  try {
    data = res.text ? JSON.parse(res.text) : null
  } catch {
    data = null
  }
  const err = (data ?? {}) as { msg?: string; message?: string; error_description?: string }
  const message = err.msg ?? err.message ?? err.error_description ?? `HTTP ${res.status}`

  return { ok: res.ok, status: res.status, data: res.ok ? (data as T) : null, message }
}

const loadSession = async ($: $) => (await $.store.get('session')) as Session | undefined

const saveSession = async ($: $, raw: { access_token: string; refresh_token: string; expires_in: number; user?: { email?: string } }, email: string) => {
  const now = await $.clock.now()
  const session: Session = {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: now + raw.expires_in * 1000,
    email: raw.user?.email ?? email,
  }
  await $.store.set('session', session)

  return session
}

// A token that is good for at least another minute, refreshed when it is not.
const token = async ($: $): Promise<string | null> => {
  const session = await loadSession($)
  if (!session) return null
  if (session.expires_at - (await $.clock.now()) > 60_000) return session.access_token

  const res = await call<{ access_token: string; refresh_token: string; expires_in: number }>(
    $,
    '/auth/v1/token?grant_type=refresh_token',
    { method: 'POST', body: { refresh_token: session.refresh_token } },
  )
  if (!res.ok || !res.data) {
    await signOut($, 'Din session er udløbet. Log ind igen.')
    return null
  }

  return (await saveSession($, res.data, session.email)).access_token
}

const signOut = async ($: $, error: string | null = null) => {
  await $.store.delete('session')
  await update($, chat, () => ({ me: null, name: null, rooms: [], roomId: null, members: [], messages: [] }))
  await update($, view, (): View => ({ phase: 'signed-out', email: null, error, isBusy: false, mode: 'none' }))
  $.ui.status(undefined)
}

// ─── Actions ────────────────────────────────────────────────────────────

const requestCode = async ($: $, input: string) => {
  const email = input.trim().toLowerCase()
  if (!isEmail(email)) return fail($, 'Det ligner ikke en e-mail.')

  await setView($, { isBusy: true, error: null })
  const res = await call($, '/auth/v1/otp', { method: 'POST', body: { email, create_user: true } })
  if (res.status === 429) {
    return fail($, 'Der er sendt for mange login-mails lige nu. Vent lidt, og prøv igen. Bliver det ved, så bed den, der driver chatten, om at hæve mail-grænsen i Supabase.')
  }
  if (!res.ok) return fail($, `Kunne ikke sende login-mailen: ${res.message}`)

  await setView($, { phase: 'code', email, isBusy: false })
}

const queryParam = (url: string, name: string) => {
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url)

  return match?.[1] === undefined ? null : decodeURIComponent(match[1])
}

// The link in Supabase's default mail, copied rather than clicked. Outlook's
// Safe Links wraps it as ...safelinks...?url=<the link>, so unwrap that first.
// Only our own project's verify link is accepted.
const linkToken = (input: string) => {
  let url = input.trim()
  const wrapped = /safelinks\.protection\.outlook\.com/i.test(url) ? queryParam(url, 'url') : null
  if (wrapped) url = wrapped
  if (!url.startsWith(`${SUPABASE}/auth/v1/verify`)) return null

  const tokenHash = queryParam(url, 'token')
  const type = queryParam(url, 'type')
  if (!tokenHash || !type || !/^(signup|magiclink|email|invite)$/.test(type)) return null

  return { token_hash: tokenHash, type }
}

const verifyCode = async ($: $, input: string) => {
  const email = (await read($, view)).email
  if (!email) return setView($, { phase: 'signed-out' })

  const code = input.replace(/\s/g, '')
  const link = /^https?:\/\//i.test(input.trim()) ? linkToken(input) : null
  if (!link && /^https?:\/\//i.test(input.trim())) return fail($, 'Det link kommer ikke fra chat-login-mailen.')
  if (!link && !/^\d{6,10}$/.test(code)) return fail($, 'Indsæt linket fra mailen, eller koden hvis mailen har en.')

  await setView($, { isBusy: true, error: null })
  const res = await call<{ access_token: string; refresh_token: string; expires_in: number; user?: { email?: string } }>(
    $,
    '/auth/v1/verify',
    { method: 'POST', body: link ?? { type: 'email', email, token: code } },
  )
  if (!res.ok || !res.data) return fail($, `Login virkede ikke: ${res.message}`)

  await saveSession($, res.data, email)
  await enterChat($)
}

// An invitation key, for signing in without a mail: `tc1:<email>:<secret>`,
// the secret being the account's password, set by whoever runs the project.
const parseKey = (input: string) => {
  const match = /^tc1:([^:\s]+@[^:\s]+):([A-Za-z0-9_-]{24,})$/.exec(input.trim())

  return match?.[1] && match[2] ? { email: match[1].toLowerCase(), password: match[2] } : null
}

const signInWithKey = async ($: $, input: string) => {
  const key = parseKey(input)
  if (!key) return fail($, 'Det ligner ikke en invitationsnøgle. Den starter med tc1:')

  await setView($, { isBusy: true, error: null })
  const res = await call<{ access_token: string; refresh_token: string; expires_in: number; user?: { email?: string } }>(
    $,
    '/auth/v1/token?grant_type=password',
    { method: 'POST', body: { email: key.email, password: key.password } },
  )
  if (!res.ok || !res.data) {
    return fail($, res.status === 400 ? 'Nøglen virker ikke (længere). Bed om en ny.' : `Login virkede ikke: ${res.message}`)
  }

  await saveSession($, res.data, key.email)
  await enterChat($)
}

const enterChat = async ($: $) => {
  const session = await loadSession($)
  if (!session) return
  const name = ((await $.store.get('name')) as string | undefined) ?? nameFrom(session.email)

  await setChat($, { me: session.email, name })
  await setView($, { phase: 'chat', email: session.email, isBusy: false, error: null })
  await loadRooms($)
  $.ui.status('💬 Team Chat')
}

const loadRooms = async ($: $) => {
  const t = await token($)
  if (!t) return
  const res = await call<Room[]>($, '/rest/v1/rooms?select=id,name&order=created_at.asc', { token: t })
  if (!res.ok || !res.data) return fail($, `Kunne ikke hente rum: ${res.message}`)

  const rooms = res.data
  const saved = (await $.store.get('roomId')) as string | undefined
  const current = (await read($, chat)).roomId
  const roomId = [current, saved].find(id => id && rooms.some(r => r.id === id)) ?? rooms[0]?.id ?? null

  await setChat($, { rooms })
  if (roomId !== current) await openRoom($, roomId)
}

const openRoom = async ($: $, roomId: string | null) => {
  await setChat($, { roomId, messages: [], members: [] })
  await setView($, { mode: 'none', error: null })
  if (!roomId) return
  await $.store.set('roomId', roomId)

  const t = await token($)
  if (!t) return
  const [msgs, members] = await Promise.all([
    call<Message[]>(
      $,
      `/rest/v1/messages?select=id,sender_email,sender_name,body,kind,created_at&room_id=eq.${roomId}&order=id.desc&limit=${KEEP}`,
      { token: t },
    ),
    call<{ email: string }[]>($, `/rest/v1/room_members?select=email&room_id=eq.${roomId}&order=joined_at.asc`, { token: t }),
  ])
  await setChat($, {
    messages: (msgs.data ?? []).reverse(),
    members: (members.data ?? []).map(m => m.email),
  })
}

const poll = async ($: $) => {
  const c = await read($, chat)
  if (!c.roomId || (await read($, view)).phase !== 'chat') return
  const t = await token($)
  if (!t) return

  const last = c.messages[c.messages.length - 1]?.id ?? 0
  const res = await call<Message[]>(
    $,
    `/rest/v1/messages?select=id,sender_email,sender_name,body,kind,created_at&room_id=eq.${c.roomId}&id=gt.${last}&order=id.asc&limit=${KEEP}`,
    { token: t },
  )
  if (!res.ok || !res.data || res.data.length === 0) return

  const fresh = res.data
  const roomId = c.roomId
  await update($, chat, now =>
    now.roomId !== roomId
      ? now
      : { ...now, messages: [...now.messages, ...fresh.filter(m => !now.messages.some(o => o.id === m.id))].slice(-KEEP) },
  )

  const theirs = fresh.filter(m => m.sender_email.toLowerCase() !== (c.me ?? '').toLowerCase())
  const newest = theirs[theirs.length - 1]
  if (newest) {
    const preview = newest.body.length > 60 ? `${newest.body.slice(0, 57)}…` : newest.body
    $.ui.toast(`💬 ${newest.sender_name}: ${preview}`, { timeoutMs: 6000 })
    $.ui.status(`💬 Ny besked fra ${newest.sender_name}`)
  }
}

const send = async ($: $, text: string, kind: Message['kind'] = 'text') => {
  const body = text.trim()
  const c = await read($, chat)
  if (!body) return
  if (!c.roomId) return fail($, 'Vælg eller opret et rum først.')

  const t = await token($)
  if (!t) return
  const res = await call<Message[]>($, '/rest/v1/messages?select=id,sender_email,sender_name,body,kind,created_at', {
    method: 'POST',
    token: t,
    prefer: 'return=representation',
    body: { room_id: c.roomId, sender_name: c.name ?? nameFrom(c.me ?? ''), body: body.slice(0, 8000), kind },
  })
  if (!res.ok || !res.data) return fail($, `Beskeden blev ikke sendt: ${res.message}`)

  const sent = res.data
  await update($, chat, now => ({
    ...now,
    messages: [...now.messages, ...sent.filter(m => !now.messages.some(o => o.id === m.id))].slice(-KEEP),
  }))
  await setView($, { error: null })
  $.ui.status('💬 Team Chat')
}

const invite = async ($: $, input: string) => {
  const email = input.trim().toLowerCase()
  const c = await read($, chat)
  if (!isEmail(email)) return fail($, 'Skriv en gyldig e-mail at invitere.')
  if (!c.roomId || !c.me) return fail($, 'Vælg et rum først.')

  const t = await token($)
  if (!t) return
  const res = await call($, '/rest/v1/room_members', {
    method: 'POST',
    token: t,
    body: { room_id: c.roomId, email, invited_by: c.me },
  })
  if (!res.ok) {
    return fail($, res.status === 409 ? `${email} er allerede med.` : `Invitationen fejlede: ${res.message}`)
  }

  await setChat($, { members: [...c.members, email] })
  await setView($, { mode: 'none', error: null })
  $.ui.toast(`✉️ ${email} er inviteret. Hun logger ind med den e-mail.`)
}

const createRoom = async ($: $, input: string) => {
  const name = input.trim().slice(0, 80)
  if (!name) return fail($, 'Giv rummet et navn.')

  const t = await token($)
  if (!t) return
  const res = await call<string>($, '/rest/v1/rpc/create_room', { method: 'POST', token: t, body: { room_name: name } })
  if (!res.ok || !res.data) return fail($, `Kunne ikke oprette rummet: ${res.message}`)

  await setChat($, { roomId: null })
  await $.store.set('roomId', res.data)
  await loadRooms($)
}

const rename = async ($: $, input: string) => {
  const name = input.trim().slice(0, 60)
  if (!name) return
  await $.store.set('name', name)
  await setChat($, { name })
}

// ─── Look ───────────────────────────────────────────────────────────────

// Mid-tone accents read on a light pane and a dark one alike.
const accent = '#1E7FC9'
const lagoon = '#17A398'
const people = ['#1E7FC9', '#17A398', '#E8643F', '#8E7BE6', '#C98A00', '#E0567A']

const colorFor = (email: string) => {
  let hash = 0
  for (const ch of email.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0

  return people[hash % people.length] ?? accent
}

const initial = (name: string) => (name.trim().charAt(0) || '?').toUpperCase()

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const avatarSvg = (name: string, email: string, size: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="${size}" height="${size}">
  <circle cx="14" cy="14" r="14" fill="${colorFor(email)}"/>
  <text x="14" y="18.6" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="13" font-weight="700" fill="#FFFFFF">${escapeXml(initial(nameFrom(email) || name))}</text>
</svg>`

const STACK_SHOWN = 5
const stackWidth = (count: number) => 26 + (Math.min(count, STACK_SHOWN) - 1) * 17

const stackSvg = (emails: string[]) => {
  const shown = emails.slice(0, STACK_SHOWN)
  const extra = emails.length - shown.length
  const width = stackWidth(emails.length)
  const circles = shown
    .map((email, i) => {
      const x = 13 + i * 17
      const isMore = extra > 0 && i === shown.length - 1

      return `<circle cx="${x}" cy="13" r="12" fill="${isMore ? '#7D8B99' : colorFor(email)}" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="2"/>
  <text x="${x}" y="17.5" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="${isMore ? 10 : 11.5}" font-weight="700" fill="#FFFFFF">${isMore ? `+${extra + 1}` : escapeXml(initial(nameFrom(email)))}</text>`
    })
    .join('\n  ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 26" width="${width}" height="26">
  ${circles}
</svg>`
}

const months = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.']

const dayLabel = (iso: string, nowMs: number) => {
  const d = new Date(iso)
  const today = new Date(nowMs)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (diff === 0) return 'I dag'
  if (diff === 1) return 'I går'

  return `${d.getDate()}. ${months[d.getMonth()] ?? ''}`
}

// ─── Banners (desktop) ──────────────────────────────────────────────────

// Fixed light surfaces with their own ink, so cards and bubbles look the
// same on a light pane and a dark one.
const ink = '#14212E'
const softInk = '#5B6B7A'
const cloud = '#EEF2F6'
const sky = '#F2F8FD'
const skyLine = '#CFE3F5'
const mint = '#E6F6F4'

const FONT = 'Segoe UI, system-ui, -apple-system, sans-serif'
const BANNER_W = 640

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const decor = (w: number, h: number) => `
  <circle cx="${w - 70}" cy="-20" r="90" fill="#FFFFFF" opacity="0.08"/>
  <circle cx="${w - 10}" cy="${h + 10}" r="60" fill="#FFFFFF" opacity="0.07"/>
  <circle cx="${w * 0.55}" cy="${h + 30}" r="70" fill="#FFFFFF" opacity="0.05"/>
  <path d="M0 ${h - 18} C ${w * 0.2} ${h - 34}, ${w * 0.4} ${h - 2}, ${w * 0.62} ${h - 16} S ${w * 0.9} ${h - 30}, ${w} ${h - 14} L ${w} ${h} L 0 ${h} Z" fill="#FFFFFF" opacity="0.10"/>`

const gradient = (id: string) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1E7FC9"/><stop offset="0.6" stop-color="#1B95B8"/><stop offset="1" stop-color="#17A398"/>
  </linearGradient>`

const roomBannerSvg = (room: string, members: string[], subtitle: string) => {
  const h = 104
  const shown = members.slice(0, 5)
  const extra = members.length - shown.length
  const startX = BANNER_W - 28 - (shown.length - 1) * 30 - (extra > 0 ? 30 : 0)
  const faces = shown
    .map(
      (email, i) => `
  <circle cx="${startX + i * 30}" cy="40" r="17" fill="${colorFor(email)}" stroke="#FFFFFF" stroke-width="3"/>
  <text x="${startX + i * 30}" y="45.5" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="#FFFFFF">${escapeXml(initial(nameFrom(email)))}</text>`,
    )
    .join('')
  const more =
    extra > 0
      ? `<circle cx="${startX + shown.length * 30}" cy="40" r="17" fill="#FFFFFF" opacity="0.9"/><text x="${startX + shown.length * 30}" y="45" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#1E7FC9">+${extra}</text>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BANNER_W} ${h}" width="${BANNER_W}" height="${h}">
  <defs>${gradient('g')}<clipPath id="r"><rect width="${BANNER_W}" height="${h}" rx="18"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="${BANNER_W}" height="${h}" fill="url(#g)"/>
    ${decor(BANNER_W, h)}
    <text x="26" y="30" font-family="${FONT}" font-size="12" font-weight="600" letter-spacing="2" fill="#FFFFFF" opacity="0.75">TEAM CHAT</text>
    <text x="26" y="62" font-family="${FONT}" font-size="28" font-weight="700" fill="#FFFFFF"># ${escapeXml(clip(room, 26))}</text>
    <text x="26" y="86" font-family="${FONT}" font-size="13" fill="#FFFFFF" opacity="0.85">${escapeXml(subtitle)}</text>
    ${faces}${more}
  </g>
</svg>`
}

const welcomeSvg = (title: string, subtitle: string) => {
  const h = 150

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BANNER_W} ${h}" width="${BANNER_W}" height="${h}">
  <defs>${gradient('g')}<clipPath id="r"><rect width="${BANNER_W}" height="${h}" rx="18"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="${BANNER_W}" height="${h}" fill="url(#g)"/>
    ${decor(BANNER_W, h)}
    <g transform="translate(${BANNER_W - 190} 26)">
      <rect x="0" y="10" width="120" height="58" rx="18" fill="#FFFFFF" opacity="0.95"/>
      <path d="M22 66 L14 86 L40 68 Z" fill="#FFFFFF" opacity="0.95"/>
      <rect x="18" y="28" width="70" height="8" rx="4" fill="#1E7FC9" opacity="0.5"/>
      <rect x="18" y="44" width="48" height="8" rx="4" fill="#1E7FC9" opacity="0.3"/>
      <rect x="70" y="48" width="96" height="48" rx="16" fill="#0E5A8A"/>
      <path d="M150 94 L160 110 L138 96 Z" fill="#0E5A8A"/>
      <circle cx="98" cy="72" r="4.5" fill="#FFFFFF"/><circle cx="118" cy="72" r="4.5" fill="#FFFFFF" opacity="0.8"/><circle cx="138" cy="72" r="4.5" fill="#FFFFFF" opacity="0.6"/>
    </g>
    <text x="28" y="36" font-family="${FONT}" font-size="12" font-weight="600" letter-spacing="2" fill="#FFFFFF" opacity="0.75">TEAM CHAT</text>
    <text x="28" y="80" font-family="${FONT}" font-size="28" font-weight="700" fill="#FFFFFF">${escapeXml(title)}</text>
    <text x="28" y="108" font-family="${FONT}" font-size="14" fill="#FFFFFF" opacity="0.88">${escapeXml(subtitle)}</text>
  </g>
</svg>`
}

const emptySvg = (title: string, subtitle: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BANNER_W} 170" width="${BANNER_W}" height="170">
  <g transform="translate(${BANNER_W / 2 - 60} 14)">
    <circle cx="60" cy="44" r="44" fill="#1E7FC9" opacity="0.08"/>
    <rect x="22" y="18" width="62" height="38" rx="14" fill="#1E7FC9" opacity="0.85"/>
    <path d="M34 54 L28 68 L48 56 Z" fill="#1E7FC9" opacity="0.85"/>
    <rect x="46" y="40" width="54" height="34" rx="12" fill="#17A398"/>
    <path d="M88 72 L96 84 L78 74 Z" fill="#17A398"/>
    <text x="73" y="63" text-anchor="middle" font-size="16">👋</text>
  </g>
  <text x="${BANNER_W / 2}" y="128" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="700" fill="${ink}">${escapeXml(title)}</text>
  <text x="${BANNER_W / 2}" y="152" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${softInk}">${escapeXml(subtitle)}</text>
</svg>`

// ─── Hooks ──────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chat',
      description: 'Team Chat: åbn panelet, eller send en besked',
      argumentHint: '[besked | inviter <e-mail> | rum <navn> | navn <dit navn> | log ud]',
    })
    void $.ui.open({ id: PANE, title: '💬 Chat' })

    if (await loadSession($)) {
      void enterChat($).catch(() => {})
    }
    $.clock.every(POLL_MS, () => {
      void poll($).catch(() => {})
    })

    return next(e)
  })

  on('command.run', { command: 'chat' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const tail = rest.join(' ')
    const phase = (await read($, view)).phase

    await $.ui.open({ id: PANE, title: '💬 Chat', focus: true })
    if (!args) return { text: 'Chatten er åben.' }
    if (word === 'nøgle' || word === 'key' || parseKey(args)) {
      await signInWithKey($, parseKey(args) ? args : tail)
      return { text: (await read($, view)).error ?? 'Du er logget ind i chatten 💬' }
    }
    if (phase !== 'chat') return { text: 'Log ind i chatpanelet først.' }

    if (word === 'inviter' || word === 'invite') {
      await invite($, tail)
      return { text: (await read($, view)).error ?? `Inviterede ${tail}.` }
    }
    if (word === 'rum' || word === 'room') {
      await createRoom($, tail)
      return { text: (await read($, view)).error ?? `Rummet "${tail}" er oprettet.` }
    }
    if (word === 'navn' || word === 'name') {
      await rename($, tail)
      return { text: `Du hedder nu ${tail} i chatten.` }
    }
    if (args === 'log ud' || args === 'logout') {
      await signOut($)
      return { text: 'Du er logget ud af chatten.' }
    }

    await send($, args)
    return { text: (await read($, view)).error ?? 'Sendt 💬' }
  })

  // Keep Claude's latest answer at hand for the "Del Claudes svar" button.
  // Only ever outbound: nothing from the chat is fed back to Claude.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'answer' && result.text.trim()) {
      await update($, lastReply, () => result.text.trim())
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)

      return <Text wrap="wrap">💬 Chatten bruger skrivefelter, som mobil-appen ikke har endnu. Skriv /chat besked for at sende.</Text>
    }

    const kit = $.ui.resolve(e)
    const { Box, Button, Input, Text } = kit
    const Svg = 'Svg' in kit ? kit.Svg : null
    const v = await read($, view)
    const c = await read($, chat)
    // Fill the pane's height so the composer sits at the bottom.
    const fill = e.viewport?.rows ? Math.max(10, e.viewport.rows - 3) : undefined

    const avatar = (name: string, email: string, size = 28) =>
      Svg ? (
        <Svg source={avatarSvg(name, email, size)} alt={name} width={size} height={size} />
      ) : (
        <Text color={colorFor(email)} bold>
          {initial(name)}
        </Text>
      )

    const card = (key: string, children: RenderElement | RenderElement[], tint: 'sky' | 'error' = 'sky') => (
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderColor={tint === 'error' ? '#F2B8B5' : skyLine}
        backgroundColor={tint === 'error' ? '#FDECEA' : sky}
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        {children}
      </Box>
    )

    const error = v.error
      ? card(
          'error',
          <Text color="#B3261E" wrap="wrap">
            {`⚠ ${v.error}`}
          </Text>,
          'error',
        )
      : null

    const hero = (title: string, subtitle: string) =>
      Svg ? (
        <Svg source={welcomeSvg(title, subtitle)} alt={`${title}. ${subtitle}`} />
      ) : (
        <Box flexDirection="column">
          <Text color={accent} bold>
            {`💬 ${title}`}
          </Text>
          <Text dimColor>{subtitle}</Text>
        </Box>
      )

    if (v.phase === 'signed-out') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {hero('Velkommen', 'Chat med dine kolleger lige ved siden af Claude.')}
          {card('login', [
            <Text key="t" color={ink} bold>
              Log ind med din e-mail
            </Text>,
            <Text key="d" color={softInk} wrap="wrap">
              Brug den samme e-mail som din Claude-konto. Du får en mail med et login-link.
            </Text>,
            <Input
              key="email"
              placeholder="navn@firma.dk"
              submitLabel={v.isBusy ? 'sender…' : 'Send mail →'}
              autoFocus
              onSubmit={value => void requestCode($, value)}
            />,
          ])}
          {card('key-login', [
            <Text key="t" color={ink} bold>
              Har du fået en invitationsnøgle?
            </Text>,
            <Text key="d" color={softInk} wrap="wrap">
              Indsæt den her, så logger du ind uden mail.
            </Text>,
            <Input
              key="invite-key"
              placeholder="tc1:…"
              submitLabel={v.isBusy ? 'logger ind…' : 'Log ind →'}
              onSubmit={value => void signInWithKey($, value)}
            />,
          ])}
          {error}
        </Box>
      )
    }

    if (v.phase === 'code') {
      const step = (n: string, text: string) => (
        <Box key={`step-${n}`} flexDirection="row" gap={1} alignItems="center">
          <Box borderStyle="round" borderColor={accent} backgroundColor={accent} paddingX={1}>
            <Text color="#FFFFFF" bold>
              {n}
            </Text>
          </Box>
          <Text color={ink} wrap="wrap">
            {text}
          </Text>
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {hero('Tjek din mail', `Vi har sendt et login-link til ${v.email}`)}
          {card('code', [
            step('1', 'Klik ikke på linket i mailen.'),
            step('2', 'Højreklik på det, og vælg "Kopiér link".'),
            step('3', 'Indsæt det her, og tryk Enter.'),
            <Input
              key="code"
              placeholder="https://… (eller en kode, hvis mailen har en)"
              submitLabel={v.isBusy ? 'tjekker…' : 'Log ind →'}
              autoFocus
              onSubmit={value => void verifyCode($, value)}
            />,
          ])}
          {error}
          <Button key="other-email" label="← Brug en anden e-mail" plain dimColor onPress={() => setView($, { phase: 'signed-out', error: null })} />
        </Box>
      )
    }

    const room = c.rooms.find(r => r.id === c.roomId)
    const reply = await read($, lastReply)
    const text = await read($, draft)
    const now = await $.clock.now()
    const me = (c.me ?? '').toLowerCase()
    const others = c.members.filter(m => m.toLowerCase() !== me)

    const toggle = (mode: View['mode']) => () => setView($, { mode: v.mode === mode ? 'none' : mode, error: null })

    const modeCard =
      v.mode === 'invite'
        ? card('invite-card', [
            <Text key="t" color={ink} bold>
              {`Inviter til ${room?.name ?? 'rummet'}`}
            </Text>,
            <Text key="d" color={softInk} wrap="wrap">
              Personen logger ind med denne e-mail og ser rummet med det samme.
            </Text>,
            <Input key="invite" placeholder="kollega@firma.dk" submitLabel="Inviter →" autoFocus onSubmit={value => void invite($, value)} />,
          ])
        : v.mode === 'new-room'
          ? card('room-card', [
              <Text key="t" color={ink} bold>
                Nyt rum
              </Text>,
              <Input key="new-room" placeholder="Fx Projekt Nord" submitLabel="Opret →" autoFocus onSubmit={value => void createRoom($, value)} />,
            ])
          : null

    // Messages: grouped per person within five minutes, a pill per day, the
    // time of a follow-up revealed while the pointer is on it.
    const rows: RenderElement[] = []
    c.messages.forEach((m, i) => {
      const prev = c.messages[i - 1]
      const day = dayLabel(m.created_at, now)
      const isNewDay = !prev || dayLabel(prev.created_at, now) !== day
      if (isNewDay) {
        rows.push(
          <Box key={`day-${m.id}`} justifyContent="center" marginTop={1} marginBottom={1}>
            <Box borderStyle="round" borderColor={cloud} backgroundColor={cloud} paddingX={2}>
              <Text color={softInk}>{day}</Text>
            </Box>
          </Box>,
        )
      }
      const isMine = m.sender_email.toLowerCase() === me
      const isNewGroup =
        isNewDay || !prev || prev.sender_email !== m.sender_email || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60_000

      const bubble =
        m.kind === 'share' ? (
          <Box flexDirection="column" borderStyle="round" borderColor={lagoon} backgroundColor={mint} paddingX={2} paddingY={1}>
            <Text color={lagoon} bold>
              ✨ Delt fra Claude
            </Text>
            <Text color={ink} wrap="wrap">
              {m.body}
            </Text>
          </Box>
        ) : isMine ? (
          <Box borderStyle="round" borderColor={accent} backgroundColor={accent} paddingX={2}>
            <Text color="#FFFFFF" wrap="wrap">
              {m.body}
            </Text>
          </Box>
        ) : (
          <Box borderStyle="round" borderColor={cloud} backgroundColor={cloud} paddingX={2}>
            <Text color={ink} wrap="wrap">
              {m.body}
            </Text>
          </Box>
        )

      const hoverTime = (
        <Box display="none" hover={{ display: 'flex' }} alignSelf="center">
          <Text dimColor>{clock(m.created_at)}</Text>
        </Box>
      )

      rows.push(
        isMine ? (
          <Box key={`m-${m.id}`} flexDirection="column" alignItems="flex-end" marginTop={isNewGroup ? 1 : 0}>
            {isNewGroup && <Text dimColor>{`Dig · ${clock(m.created_at)}`}</Text>}
            <Box flexDirection="row" gap={1} alignItems="center">
              {isNewGroup ? null : hoverTime}
              {bubble}
            </Box>
          </Box>
        ) : (
          <Box key={`m-${m.id}`} flexDirection="row" gap={1} marginTop={isNewGroup ? 1 : 0}>
            <Box width={4} flexShrink={0}>
              {isNewGroup ? avatar(m.sender_name, m.sender_email, 30) : null}
            </Box>
            <Box flexDirection="column" flexShrink={1} alignItems="flex-start">
              {isNewGroup && (
                <Box flexDirection="row" gap={1}>
                  <Text color={colorFor(m.sender_email)} bold>
                    {m.sender_name}
                  </Text>
                  <Text dimColor>{clock(m.created_at)}</Text>
                </Box>
              )}
              <Box flexDirection="row" gap={1} alignItems="center">
                {bubble}
                {isNewGroup ? null : hoverTime}
              </Box>
            </Box>
          </Box>
        ),
      )
    })

    const pill = (key: string, label: string, isActive: boolean, onPress: () => unknown) => (
      <Box
        key={key}
        borderStyle="round"
        borderColor={isActive ? accent : cloud}
        backgroundColor={isActive ? accent : cloud}
        paddingX={2}
        hover={isActive ? undefined : { borderColor: accent }}
      >
        <Button key={`${key}-btn`} label={label} plain onPress={onPress} />
      </Box>
    )

    const banner = room ? (
      Svg ? (
        <Svg
          source={roomBannerSvg(room.name, c.members, `${c.members.length} ${c.members.length === 1 ? 'medlem' : 'medlemmer'} · ${c.messages.length} beskeder`)}
          alt={`${room.name}, ${c.members.map(nameFrom).join(', ')}`}
        />
      ) : (
        <Box flexDirection="column">
          <Text color={accent} bold>{`# ${room.name}`}</Text>
          <Text dimColor>{c.members.map(nameFrom).join(' · ')}</Text>
        </Box>
      )
    ) : (
      hero('Team Chat', 'Opret et rum, eller bed en kollega invitere dig.')
    )

    const toolbar = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {c.rooms.map(r => pill(`pill-${r.id}`, r.name, r.id === c.roomId, () => openRoom($, r.id)))}
        {pill('pill-new', '＋ Nyt rum', v.mode === 'new-room', toggle('new-room'))}
        <Box flexGrow={1} />
        {room && pill('pill-invite', '＋ Inviter', v.mode === 'invite', toggle('invite'))}
      </Box>
    )

    const messages = !room ? null : rows.length === 0 ? (
      Svg ? (
        <Svg
          source={emptySvg(`Velkommen til ${clip(room.name, 30)}`, others.length > 0 ? `Sig hej til ${others.map(nameFrom).join(' og ')}` : 'Inviter en kollega, og sig hej')}
          alt="Ingen beskeder endnu"
        />
      ) : (
        <Text dimColor>{`Ingen beskeder i ${room.name} endnu. Sig hej 👋`}</Text>
      )
    ) : (
      <Box flexDirection="column">{rows}</Box>
    )

    const composer = room ? (
      <Box key="composer" flexDirection="column" borderStyle="round" borderColor={skyLine} backgroundColor={sky} paddingX={2} paddingY={1} gap={1}>
        <Input
          key="compose"
          placeholder={`Skriv til # ${room.name}…`}
          submitLabel="Send ➤"
          value={text}
          autoFocus
          onInput={value => void update($, draft, () => value)}
          onSubmit={value => {
            void update($, draft, () => '')
            void send($, value)
          }}
        />
        <Box flexDirection="row" alignItems="center" gap={1}>
          {reply && (
            <Box key="share-pill" borderStyle="round" borderColor={lagoon} backgroundColor={mint} paddingX={1} hover={{ borderColor: accent }}>
              <Button key="share-reply" label="✨ Del Claudes seneste svar" plain onPress={() => send($, reply, 'share')} />
            </Box>
          )}
          <Box flexGrow={1} />
          {avatar(c.name ?? '?', c.me ?? '', 20)}
          <Text color={softInk}>{c.name ?? ''}</Text>
          <Button key="sign-out" label="Log ud" plain dimColor onPress={() => signOut($)} />
        </Box>
      </Box>
    ) : (
      <Box flexDirection="row" justifyContent="flex-end" gap={1}>
        {avatar(c.name ?? '?', c.me ?? '', 20)}
        <Text dimColor>{c.name ?? ''}</Text>
        <Button key="sign-out" label="Log ud" plain dimColor onPress={() => signOut($)} />
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1} minHeight={fill}>
        {banner}
        {toolbar}
        {modeCard}
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
          {messages}
        </Box>
        {error}
        {composer}
      </Box>
    )
  })
}
