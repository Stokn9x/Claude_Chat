import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, UiPressArgument } from 'claude-code'

import type { Chat, Message, Mode, Room, View } from '../types'

// The project's public URL and publishable key: safe to ship. Each computer
// signs in as an anonymous Supabase user; Row Level Security and the room's
// invite code decide what it may read or write.
const SUPABASE = 'https://yqdumafjvdyabojuajeo.supabase.co'
const KEY = 'sb_publishable_bDtsNOxE17K2fsPr4vyUWA_QuvoO0du'
const REPO = 'Stokn9x/Claude_Chat'

const PANE = 'team-chat'
const POLL_MS = 3000
const KEEP = 200
const FOLD_CHARS = 700
const FOLD_LINES = 14

const view = atom(
  { plugin: 'team-chat', key: 'view' } as const,
  { phase: 'setup', error: null, isBusy: false, mode: 'none' } as View,
)
const chat = atom(
  { plugin: 'team-chat', key: 'chat' } as const,
  { me: null, name: null, rooms: [], roomId: null, messages: [] } as Chat,
)
const draft = atom({ plugin: 'team-chat', key: 'draft' } as const, '')
const lastReply = atom({ plugin: 'team-chat', key: 'lastReply' } as const, null as string | null)
const expanded = atom({ plugin: 'team-chat', key: 'expanded' } as const, [] as number[])

type $ = EngineInterface
type Session = { access_token: string; refresh_token: string; expires_at: number; user_id: string }
type AuthReply = { access_token: string; refresh_token: string; expires_in: number; user: { id: string } }

// ─── Small helpers ──────────────────────────────────────────────────────

const clock = (iso: string) => {
  const d = new Date(iso)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/
const normalizeCode = (text: string) => {
  const raw = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null
}

const setView = ($: $, patch: Partial<View>) => update($, view, v => ({ ...v, ...patch }))
const setChat = ($: $, patch: Partial<Chat>) => update($, chat, c => ({ ...c, ...patch }))
const fail = ($: $, error: string) => setView($, { error, isBusy: false })

const invitation = (room: Room) =>
  [
    `Kom med i #${room.name} i Team Chat 💬`,
    '',
    `1. Installér chatten i Claude: https://github.com/${REPO}`,
    `2. Åbn panelet med /chat, vælg "Deltag", og brug koden: ${room.invite_code}`,
  ].join('\n')

// A long shared reply folds to its first lines; a cut inside a code block is closed.
const fold = (body: string) => {
  const lines = body.split('\n')
  let cut = lines.slice(0, FOLD_LINES).join('\n')
  if (cut.length > FOLD_CHARS) cut = cut.slice(0, FOLD_CHARS)
  if (cut.length >= body.length) return { text: body, isFolded: false }
  if ((cut.match(/```/g) ?? []).length % 2 === 1) cut += '\n```'

  return { text: `${cut}\n\n…`, isFolded: true }
}

// ─── Supabase over the host's HTTP ──────────────────────────────────────

type Call = { method?: string; body?: unknown; token?: string; prefer?: string }
type Reply<T> = { ok: boolean; status: number; data: T | null; message: string }

const call = async <T,>($: $, path: string, init: Call = {}): Promise<Reply<T>> => {
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
  const message = err.message ?? err.msg ?? err.error_description ?? `HTTP ${res.status}`

  return { ok: res.ok, status: res.status, data: res.ok ? (data as T) : null, message }
}

// A session saved by the e-mail login of 0.1/0.2 has no user_id: start over.
const loadSession = async ($: $) => {
  const session = (await $.store.get('session')) as Partial<Session> | undefined
  if (session && !session.user_id) {
    await $.store.delete('session')
    await $.store.delete('roomId')
    return undefined
  }

  return session as Session | undefined
}

const saveSession = async ($: $, raw: AuthReply) => {
  const session: Session = {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: (await $.clock.now()) + raw.expires_in * 1000,
    user_id: raw.user.id,
  }
  await $.store.set('session', session)

  return session
}

// This computer's anonymous account, created the first time it is needed.
const ensureSession = async ($: $): Promise<Session | null> => {
  const existing = await loadSession($)
  if (existing) return existing

  const res = await call<AuthReply>($, '/auth/v1/signup', { method: 'POST', body: {} })
  if (!res.ok || !res.data) {
    await fail($, res.status === 429 ? 'For mange nye forbindelser lige nu. Prøv igen om lidt.' : `Kunne ikke forbinde: ${res.message}`)
    return null
  }

  return saveSession($, res.data)
}

// A token good for at least another minute, refreshed when it is not.
const token = async ($: $): Promise<string | null> => {
  const session = await loadSession($)
  if (!session) return null
  if (session.expires_at - (await $.clock.now()) > 60_000) return session.access_token

  const res = await call<AuthReply>($, '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: session.refresh_token },
  })
  if (!res.ok || !res.data) {
    await fail($, 'Forbindelsen til chatten er udløbet. Prøv igen om lidt.')
    return null
  }

  return (await saveSession($, res.data)).access_token
}

const rpc = async <T,>($: $, name: string, body: Record<string, unknown> = {}) => {
  const t = await token($)
  if (!t) return { ok: false, status: 401, data: null, message: 'not signed in' } as Reply<T>

  return call<T>($, `/rest/v1/rpc/${name}`, { method: 'POST', token: t, body })
}

const MSG_FIELDS = 'select=id,sender_id,sender_name,body,kind,created_at'

// ─── Actions ────────────────────────────────────────────────────────────

const setName = async ($: $, input: string) => {
  const name = input.trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!name) return fail($, 'Skriv det navn, kollegerne skal se.')

  await setView($, { isBusy: true, error: null })
  const session = await ensureSession($)
  if (!session) return

  const c = await read($, chat)
  if (c.rooms.length > 0) {
    const res = await rpc($, 'set_my_name', { my_name: name })
    if (!res.ok) {
      return fail($, res.message.includes('name_taken') ? `Navnet "${name}" er taget i et af dine rum. Vælg et andet.` : `Kunne ikke skifte navn: ${res.message}`)
    }
  }

  await $.store.set('name', name)
  await setChat($, { me: session.user_id, name })
  await setView($, { phase: 'chat', isBusy: false, mode: 'none' })
  await loadRooms($)
  await openRoom($, (await read($, chat)).roomId)
  $.ui.status('💬 Team Chat')
}

const enterChat = async ($: $) => {
  const session = await loadSession($)
  const name = (await $.store.get('name')) as string | undefined
  if (!session || !name) return

  await setChat($, { me: session.user_id, name })
  await setView($, { phase: 'chat', error: null, isBusy: false })
  await loadRooms($)
  await openRoom($, (await read($, chat)).roomId)
  $.ui.status('💬 Team Chat')
}

const loadRooms = async ($: $) => {
  const res = await rpc<Room[]>($, 'my_rooms')
  if (!res.ok || !res.data) return

  const rooms = res.data.map(r => ({ ...r, unread: Number(r.unread) || 0, members: r.members ?? [] }))
  const c = await read($, chat)
  const saved = (await $.store.get('roomId')) as string | undefined
  const roomId = [c.roomId, saved].find(id => id && rooms.some(r => r.id === id)) ?? rooms[0]?.id ?? null

  // A room I am not looking at that gained messages since the last poll.
  if (c.rooms.length > 0) {
    for (const r of rooms) {
      const before = c.rooms.find(o => o.id === r.id)
      if (r.id !== c.roomId && r.unread > (before?.unread ?? 0)) {
        $.ui.toast(`💬 ${r.unread} ${r.unread === 1 ? 'ny besked' : 'nye beskeder'} i #${r.name}`, { timeoutMs: 6000 })
      }
    }
  }

  await setChat($, { rooms, roomId })
}

const openRoom = async ($: $, roomId: string | null) => {
  const c = await read($, chat)
  if (roomId !== c.roomId) await setChat($, { roomId, messages: [] })
  await setView($, { mode: 'none', error: null })
  if (!roomId) return
  await $.store.set('roomId', roomId)

  const t = await token($)
  if (!t) return
  const res = await call<Message[]>($, `/rest/v1/messages?${MSG_FIELDS}&room_id=eq.${roomId}&order=id.desc&limit=${KEEP}`, { token: t })
  const messages = (res.data ?? []).reverse()
  await setChat($, { messages })
  await markRead($, roomId, messages)
}

const markRead = async ($: $, roomId: string, messages: Message[]) => {
  const last = messages[messages.length - 1]?.id
  if (!last) return
  await rpc($, 'mark_read', { target: roomId, upto: last })
  await update($, chat, c => ({ ...c, rooms: c.rooms.map(r => (r.id === roomId ? { ...r, unread: 0 } : r)) }))
}

const poll = async ($: $) => {
  if ((await read($, view)).phase !== 'chat') return
  await loadRooms($)

  const c = await read($, chat)
  if (!c.roomId) return
  const t = await token($)
  if (!t) return

  const last = c.messages[c.messages.length - 1]?.id ?? 0
  const res = await call<Message[]>($, `/rest/v1/messages?${MSG_FIELDS}&room_id=eq.${c.roomId}&id=gt.${last}&order=id.asc&limit=${KEEP}`, { token: t })
  if (!res.ok || !res.data || res.data.length === 0) return

  const fresh = res.data
  const roomId = c.roomId
  await update($, chat, now =>
    now.roomId !== roomId
      ? now
      : { ...now, messages: [...now.messages, ...fresh.filter(m => !now.messages.some(o => o.id === m.id))].slice(-KEEP) },
  )
  await markRead($, roomId, fresh)

  const newest = fresh.filter(m => m.sender_id !== c.me).pop()
  if (newest) {
    const text = newest.kind === 'share' ? 'delte et svar fra Claude' : newest.body
    $.ui.toast(`💬 ${newest.sender_name}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`, { timeoutMs: 6000 })
  }
}

const send = async ($: $, text: string, kind: Message['kind'] = 'text') => {
  const body = text.trim()
  const c = await read($, chat)
  if (!body) return
  if (!c.roomId) return fail($, 'Opret eller deltag i et rum først.')

  const t = await token($)
  if (!t) return
  const res = await call<Message[]>($, `/rest/v1/messages?${MSG_FIELDS}`, {
    method: 'POST',
    token: t,
    prefer: 'return=representation',
    body: { room_id: c.roomId, body: body.slice(0, 8000), kind },
  })
  if (!res.ok || !res.data) return fail($, `Beskeden blev ikke sendt: ${res.message}`)

  const sent = res.data
  await update($, chat, now => ({
    ...now,
    messages: [...now.messages, ...sent.filter(m => !now.messages.some(o => o.id === m.id))].slice(-KEEP),
  }))
  await setView($, { error: null })
}

const createRoom = async ($: $, input: string) => {
  const name = input.trim().replace(/^#/, '').slice(0, 80)
  const c = await read($, chat)
  if (!name) return fail($, 'Giv rummet et navn.')

  await setView($, { isBusy: true, error: null })
  const res = await rpc<{ id: string }>($, 'create_room', { room_name: name, my_name: c.name })
  if (!res.ok || !res.data) return fail($, `Kunne ikke oprette rummet: ${res.message}`)

  await setChat($, { roomId: res.data.id })
  await loadRooms($)
  await openRoom($, res.data.id)
  await setView($, { isBusy: false, mode: 'code' })
}

const joinRoom = async ($: $, input: string) => {
  const code = normalizeCode(input)
  const c = await read($, chat)
  if (!code) return fail($, 'En kode ser sådan ud: ABCD-EF23')

  await setView($, { isBusy: true, error: null })
  const res = await rpc<{ id: string; name: string }>($, 'join_room', { code, my_name: c.name })
  if (!res.ok || !res.data) {
    if (res.message.includes('unknown_code')) return fail($, `Der er intet rum med koden ${code}.`)
    if (res.message.includes('name_taken')) return fail($, `Der er allerede en "${c.name}" i det rum. Skift dit navn med ✏️ og prøv igen.`)
    return fail($, `Kunne ikke deltage: ${res.message}`)
  }

  await setChat($, { roomId: res.data.id })
  await loadRooms($)
  await openRoom($, res.data.id)
  await setView($, { isBusy: false })
  $.ui.toast(`🎉 Du er med i #${res.data.name}`)
}

const leaveRoom = async ($: $) => {
  const c = await read($, chat)
  if (!c.roomId) return
  await rpc($, 'leave_room', { target: c.roomId })
  await setChat($, { roomId: null, messages: [] })
  await $.store.delete('roomId')
  await loadRooms($)
  await openRoom($, (await read($, chat)).roomId)
}

// ─── Look ───────────────────────────────────────────────────────────────

// Mid-tone accents read on a light pane and a dark one alike; cards and
// bubbles carry their own fixed light surface and ink.
const accent = '#1E7FC9'
const lagoon = '#17A398'
const ink = '#14212E'
const softInk = '#5B6B7A'
const cloud = '#EEF2F6'
const sky = '#F2F8FD'
const skyLine = '#CFE3F5'
const mint = '#E6F6F4'
const people = ['#1E7FC9', '#17A398', '#E8643F', '#8E7BE6', '#C98A00', '#E0567A']

const colorFor = (id: string) => {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0

  return people[hash % people.length] ?? accent
}

const initial = (name: string) => (name.trim().charAt(0) || '?').toUpperCase()

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const FONT = 'Segoe UI, system-ui, -apple-system, sans-serif'
const BANNER_W = 640

const avatarSvg = (name: string, id: string, size: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="${size}" height="${size}">
  <circle cx="14" cy="14" r="14" fill="${colorFor(id)}"/>
  <text x="14" y="18.6" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="#FFFFFF">${escapeXml(initial(name))}</text>
</svg>`

const decor = (w: number, h: number) => `
  <circle cx="${w - 70}" cy="-20" r="90" fill="#FFFFFF" opacity="0.08"/>
  <circle cx="${w - 10}" cy="${h + 10}" r="60" fill="#FFFFFF" opacity="0.07"/>
  <circle cx="${w * 0.55}" cy="${h + 30}" r="70" fill="#FFFFFF" opacity="0.05"/>
  <path d="M0 ${h - 18} C ${w * 0.2} ${h - 34}, ${w * 0.4} ${h - 2}, ${w * 0.62} ${h - 16} S ${w * 0.9} ${h - 30}, ${w} ${h - 14} L ${w} ${h} L 0 ${h} Z" fill="#FFFFFF" opacity="0.10"/>`

const gradient = (id: string) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1E7FC9"/><stop offset="0.6" stop-color="#1B95B8"/><stop offset="1" stop-color="#17A398"/>
  </linearGradient>`

const roomBannerSvg = (room: Room) => {
  const h = 104
  const shown = room.members.slice(0, 5)
  const extra = room.members.length - shown.length
  const step = 30
  const startX = BANNER_W - 28 - (shown.length - 1) * step - (extra > 0 ? step : 0)
  const faces = shown
    .map(
      (m, i) => `
  <circle cx="${startX + i * step}" cy="40" r="17" fill="${colorFor(m.user_id)}" stroke="#FFFFFF" stroke-width="3"/>
  <text x="${startX + i * step}" y="45.5" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="#FFFFFF">${escapeXml(initial(m.name))}</text>`,
    )
    .join('')
  const more =
    extra > 0
      ? `<circle cx="${startX + shown.length * step}" cy="40" r="17" fill="#FFFFFF" opacity="0.9"/><text x="${startX + shown.length * step}" y="45" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="700" fill="#1E7FC9">+${extra}</text>`
      : ''
  const names = clip(room.members.map(m => m.name).join(', '), 48)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BANNER_W} ${h}" width="${BANNER_W}" height="${h}">
  <defs>${gradient('g')}<clipPath id="r"><rect width="${BANNER_W}" height="${h}" rx="18"/></clipPath></defs>
  <g clip-path="url(#r)">
    <rect width="${BANNER_W}" height="${h}" fill="url(#g)"/>
    ${decor(BANNER_W, h)}
    <text x="26" y="30" font-family="${FONT}" font-size="12" font-weight="600" letter-spacing="2" fill="#FFFFFF" opacity="0.75">TEAM CHAT</text>
    <text x="26" y="62" font-family="${FONT}" font-size="28" font-weight="700" fill="#FFFFFF"># ${escapeXml(clip(room.name, 24))}</text>
    <text x="26" y="86" font-family="${FONT}" font-size="13" fill="#FFFFFF" opacity="0.85">${escapeXml(names)}</text>
    <g transform="translate(${BANNER_W - 150} 66)">
      <rect width="124" height="24" rx="12" fill="#FFFFFF" opacity="0.18"/>
      <text x="62" y="16.5" text-anchor="middle" font-family="Consolas, monospace" font-size="13" font-weight="700" letter-spacing="1" fill="#FFFFFF">${escapeXml(room.invite_code)}</text>
    </g>
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
    <text x="28" y="80" font-family="${FONT}" font-size="28" font-weight="700" fill="#FFFFFF">${escapeXml(clip(title, 22))}</text>
    <text x="28" y="108" font-family="${FONT}" font-size="14" fill="#FFFFFF" opacity="0.88">${escapeXml(clip(subtitle, 52))}</text>
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

// ─── Hooks ──────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chat',
      description: 'Team Chat: åbn panelet, eller send en besked',
      argumentHint: '[besked | deltag <kode> | rum <navn> | navn <dit navn> | kode | forlad]',
    })
    void $.ui.open({ id: PANE, title: '💬 Chat' })
    void enterChat($).catch(() => {})
    $.clock.every(POLL_MS, () => {
      void poll($).catch(() => {})
    })

    return next(e)
  })

  on('command.run', { command: 'chat' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const tail = rest.join(' ')
    const result = async (ok: string) => ({ text: (await read($, view)).error ?? ok })

    await $.ui.open({ id: PANE, title: '💬 Chat', focus: true })
    if (!args) return { text: 'Chatten er åben.' }

    if (word === 'navn' || word === 'name') {
      await setName($, tail)
      return result(`Du hedder nu ${tail} i chatten.`)
    }
    if ((await read($, view)).phase !== 'chat') return { text: 'Skriv dit navn i chatpanelet først.' }

    if (word === 'deltag' || word === 'join' || CODE.test(args)) {
      await joinRoom($, CODE.test(args) ? args : tail)
      return result('Du er med 🎉')
    }
    if (word === 'rum' || word === 'room') {
      await createRoom($, tail)
      return result(`Rummet "${tail}" er oprettet. Koden står i panelet.`)
    }
    if (word === 'kode' || word === 'code') {
      const c = await read($, chat)
      const room = c.rooms.find(r => r.id === c.roomId)
      return { text: room ? `Koden til #${room.name} er ${room.invite_code}` : 'Du er ikke i et rum.' }
    }
    if (word === 'forlad' || word === 'leave') {
      await leaveRoom($)
      return { text: 'Du har forladt rummet.' }
    }

    await send($, args)
    return result('Sendt 💬')
  })

  // Keep Claude's latest answer at hand for "Del Claudes seneste svar".
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
    const { Box, Button, Input, Markdown, Text } = kit
    const Svg = 'Svg' in kit ? kit.Svg : null
    const v = await read($, view)
    const c = await read($, chat)
    const fill = e.viewport?.rows ? Math.max(10, e.viewport.rows - 3) : undefined

    const avatar = (name: string, id: string, size = 28) =>
      Svg ? (
        <Svg source={avatarSvg(name, id, size)} alt={name} width={size} height={size} />
      ) : (
        <Text color={colorFor(id)} bold>
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

    const title = (key: string, text: string) => (
      <Text key={key} color={ink} bold>
        {text}
      </Text>
    )
    const hint = (key: string, text: string) => (
      <Text key={key} color={softInk} wrap="wrap">
        {text}
      </Text>
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

    const hero = (head: string, sub: string) =>
      Svg ? (
        <Svg source={welcomeSvg(head, sub)} alt={`${head}. ${sub}`} />
      ) : (
        <Box flexDirection="column">
          <Text color={accent} bold>
            {`💬 ${head}`}
          </Text>
          <Text dimColor>{sub}</Text>
        </Box>
      )

    const pill = (key: string, label: string, isActive: boolean, onPress: (press: UiPressArgument) => unknown) => (
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

    if (v.phase === 'setup') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {hero('Velkommen', 'Chat med dine kolleger lige ved siden af Claude.')}
          {card('setup', [
            title('t', 'Hvad skal vi kalde dig?'),
            hint('d', 'Det navn, dine kolleger ser. Du kan altid skifte det.'),
            <Input
              key="my-name"
              placeholder="Dit navn"
              submitLabel={v.isBusy ? 'et øjeblik…' : 'Kom i gang →'}
              autoFocus
              onSubmit={value => void setName($, value)}
            />,
          ])}
          {error}
        </Box>
      )
    }

    const room = c.rooms.find(r => r.id === c.roomId)
    const reply = await read($, lastReply)
    const text = await read($, draft)
    const open = await read($, expanded)
    const now = await $.clock.now()
    const nameOf = (m: Message) => room?.members.find(x => x.user_id === m.sender_id)?.name ?? m.sender_name

    const toggle = (mode: Mode) => () => setView($, { mode: v.mode === mode ? 'none' : mode, error: null })

    const joinCard = card('join-card', [
      title('t', 'Deltag i et rum'),
      hint('d', 'Indsæt den kode, du har fået af en kollega.'),
      <Input key="join-code" placeholder="ABCD-EF23" submitLabel={v.isBusy ? 'et øjeblik…' : 'Deltag →'} autoFocus onSubmit={value => void joinRoom($, value)} />,
    ])
    const newRoomCard = card('room-card', [
      title('t', 'Opret et rum'),
      hint('d', 'Du får en kode, som dine kolleger kan deltage med.'),
      <Input key="new-room" placeholder="Fx Projekt Nord" submitLabel={v.isBusy ? 'et øjeblik…' : 'Opret →'} onSubmit={value => void createRoom($, value)} />,
    ])
    const nameCard = card('name-card', [
      title('t', 'Skift dit navn'),
      hint('d', `Lige nu hedder du ${c.name ?? ''}. Det nye navn gælder i alle dine rum.`),
      <Input key="rename" placeholder={c.name ?? 'Dit navn'} submitLabel="Gem →" autoFocus onSubmit={value => void setName($, value)} />,
    ])
    const codeCard = room
      ? card('code-card', [
          title('t', `Inviter til #${room.name}`),
          hint('d', 'Send koden til dine kolleger. De vælger "Deltag" i chatpanelet og indsætter den.'),
          <Box key="code" flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
            <Box borderStyle="round" borderColor={accent} paddingX={2}>
              <Text color={accent} bold>
                {room.invite_code}
              </Text>
            </Box>
            {pill('copy-code', '📋 Kopiér kode', false, (press: UiPressArgument) =>
              $.ui.copy({ text: room.invite_code, surface: press.surface }).then(() => $.ui.toast('Koden er kopieret')),
            )}
            {pill('copy-invite', '✉️ Kopiér invitation', false, (press: UiPressArgument) =>
              $.ui.copy({ text: invitation(room), surface: press.surface }).then(() => $.ui.toast('Invitationen er kopieret')),
            )}
          </Box>,
          <Button key="leave" label="Forlad rummet" plain dimColor onPress={() => leaveRoom($)} />,
        ])
      : null

    const modeCard =
      v.mode === 'join' ? joinCard : v.mode === 'new-room' ? newRoomCard : v.mode === 'name' ? nameCard : v.mode === 'code' ? codeCard : null

    const me = (
      <Box key="me" flexDirection="row" alignItems="center" gap={1}>
        {avatar(c.name ?? '?', c.me ?? '', 20)}
        <Text color={softInk}>{c.name ?? ''}</Text>
        <Button key="rename-toggle" label="✏️" plain dimColor onPress={toggle('name')} />
      </Box>
    )

    if (!room) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {hero(`Hej ${c.name ?? ''}`, 'Opret et rum, eller deltag med en kode.')}
          {joinCard}
          {newRoomCard}
          {v.mode === 'name' ? nameCard : null}
          {error}
          <Box flexDirection="row" justifyContent="flex-end">
            {me}
          </Box>
        </Box>
      )
    }

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
      const isMine = m.sender_id === c.me
      const isNewGroup =
        isNewDay || !prev || prev.sender_id !== m.sender_id || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60_000

      let bubble: RenderElement
      if (m.kind === 'share') {
        const isOpen = open.includes(m.id)
        const shown = isOpen ? { text: m.body, isFolded: false } : fold(m.body)
        const canFold = isOpen || shown.isFolded
        bubble = (
          <Box flexDirection="column" borderStyle="round" borderColor={lagoon} backgroundColor={mint} paddingX={2} paddingY={1} gap={1}>
            <Text color={lagoon} bold>
              {isMine ? '✨ Du delte et svar fra Claude' : `✨ ${nameOf(m)} delte et svar fra Claude`}
            </Text>
            <Markdown text={shown.text} />
            {canFold && (
              <Button
                key={`fold-${m.id}`}
                label={isOpen ? 'Vis mindre ↑' : 'Vis mere ↓'}
                plain
                onPress={() => update($, expanded, ids => (ids.includes(m.id) ? ids.filter(x => x !== m.id) : [...ids, m.id]))}
              />
            )}
          </Box>
        )
      } else {
        bubble = isMine ? (
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
      }

      const hoverTime = (
        <Box display="none" hover={{ display: 'flex' }} alignSelf="center">
          <Text dimColor>{clock(m.created_at)}</Text>
        </Box>
      )

      rows.push(
        m.kind === 'share' ? (
          <Box key={`m-${m.id}`} flexDirection="column" marginTop={1}>
            <Text dimColor>{clock(m.created_at)}</Text>
            {bubble}
          </Box>
        ) : isMine ? (
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
              {isNewGroup ? avatar(nameOf(m), m.sender_id, 30) : null}
            </Box>
            <Box flexDirection="column" flexShrink={1} alignItems="flex-start">
              {isNewGroup && (
                <Box flexDirection="row" gap={1}>
                  <Text color={colorFor(m.sender_id)} bold>
                    {nameOf(m)}
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

    const others = room.members.filter(m => m.user_id !== c.me)

    const banner = Svg ? (
      <Svg source={roomBannerSvg(room)} alt={`#${room.name}: ${room.members.map(m => m.name).join(', ')}. Kode ${room.invite_code}`} />
    ) : (
      <Box flexDirection="column">
        <Text color={accent} bold>{`# ${room.name}`}</Text>
        <Text dimColor>{`${room.members.map(m => m.name).join(' · ')} · kode ${room.invite_code}`}</Text>
      </Box>
    )

    const toolbar = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {c.rooms.map(r =>
          pill(`pill-${r.id}`, r.unread > 0 && r.id !== c.roomId ? `${r.name}  ● ${r.unread}` : r.name, r.id === c.roomId, () => openRoom($, r.id)),
        )}
        {pill('pill-new', '＋ Nyt rum', v.mode === 'new-room', toggle('new-room'))}
        {pill('pill-join', '⇥ Deltag', v.mode === 'join', toggle('join'))}
        <Box flexGrow={1} />
        {pill('pill-invite', '🔗 Inviter', v.mode === 'code', toggle('code'))}
      </Box>
    )

    const messages =
      rows.length === 0 ? (
        Svg ? (
          <Svg
            source={emptySvg(`Velkommen til #${clip(room.name, 28)}`, others.length > 0 ? `Sig hej til ${others.map(m => m.name).join(' og ')}` : 'Inviter en kollega med 🔗 Inviter, og sig hej')}
            alt="Ingen beskeder endnu"
          />
        ) : (
          <Text dimColor>{`Ingen beskeder i #${room.name} endnu. Sig hej 👋`}</Text>
        )
      ) : (
        <Box flexDirection="column">{rows}</Box>
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
        <Box key="composer" flexDirection="column" borderStyle="round" borderColor={skyLine} backgroundColor={sky} paddingX={2} paddingY={1} gap={1}>
          <Input
            key="compose"
            placeholder={`Skriv til #${room.name}…`}
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
            {me}
          </Box>
        </Box>
      </Box>
    )
  })
}
