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
  if (!res.ok) return fail($, `Kunne ikke sende koden: ${res.message}`)

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

    const avatar = (name: string, email: string, size = 28) =>
      Svg ? (
        <Svg source={avatarSvg(name, email, size)} alt={name} width={size} height={size} />
      ) : (
        <Text color={colorFor(email)} bold>
          {initial(name)}
        </Text>
      )

    const error = v.error ? (
      <Box borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error" wrap="wrap">
          {v.error}
        </Text>
      </Box>
    ) : null

    const brand = (subtitle: string) => (
      <Box flexDirection="column">
        <Text color={accent} bold>
          💬 Team Chat
        </Text>
        <Text dimColor wrap="wrap">
          {subtitle}
        </Text>
      </Box>
    )

    if (v.phase === 'signed-out') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {brand('Chat med dine kolleger lige ved siden af Claude.')}
          <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={1} gap={1}>
            <Text bold>Log ind</Text>
            <Text wrap="wrap">Brug den e-mail, du også bruger til Claude. Du får en mail med et login-link.</Text>
            <Input
              key="email"
              placeholder="navn@firma.dk"
              submitLabel={v.isBusy ? 'sender…' : 'send mail'}
              autoFocus
              onSubmit={value => void requestCode($, value)}
            />
          </Box>
          {error}
        </Box>
      )
    }

    if (v.phase === 'code') {
      return (
        <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
          {brand(`Vi har sendt en mail til ${v.email}.`)}
          <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={1} gap={1}>
            <Text bold>Indsæt linket fra mailen</Text>
            <Text wrap="wrap">1. Klik ikke på linket.</Text>
            <Text wrap="wrap">2. Højreklik på det og vælg "Kopiér link".</Text>
            <Text wrap="wrap">3. Indsæt det her og tryk Enter.</Text>
            <Input
              key="code"
              placeholder="https://… (eller en kode, hvis mailen har en)"
              submitLabel={v.isBusy ? 'tjekker…' : 'log ind'}
              autoFocus
              onSubmit={value => void verifyCode($, value)}
            />
          </Box>
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

    const toggle = (mode: View['mode']) => () => setView($, { mode: v.mode === mode ? 'none' : mode, error: null })

    const modeCard =
      v.mode === 'invite' ? (
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} gap={0}>
          <Text bold>Inviter til {room?.name ?? 'rummet'}</Text>
          <Text dimColor wrap="wrap">
            Personen logger ind med denne e-mail og ser rummet med det samme.
          </Text>
          <Input key="invite" placeholder="kollega@firma.dk" submitLabel="inviter" autoFocus onSubmit={value => void invite($, value)} />
        </Box>
      ) : v.mode === 'new-room' ? (
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
          <Text bold>Nyt rum</Text>
          <Input key="new-room" placeholder="Fx Projekt Nord" submitLabel="opret" autoFocus onSubmit={value => void createRoom($, value)} />
        </Box>
      ) : null

    // Messages: grouped per person within five minutes, a divider per day.
    const rows: RenderElement[] = []
    c.messages.forEach((m, i) => {
      const prev = c.messages[i - 1]
      const day = dayLabel(m.created_at, now)
      if (!prev || dayLabel(prev.created_at, now) !== day) {
        rows.push(
          <Box key={`day-${m.id}`} justifyContent="center" marginTop={1}>
            <Text dimColor>{`— ${day} —`}</Text>
          </Box>,
        )
      }
      const isMine = m.sender_email.toLowerCase() === me
      const isNewGroup =
        !prev ||
        prev.sender_email !== m.sender_email ||
        Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60_000 ||
        dayLabel(prev.created_at, now) !== day
      const isShare = m.kind === 'share'

      const bubble = isShare ? (
        <Box flexDirection="column" borderStyle="round" borderColor={lagoon} paddingX={1}>
          <Text color={lagoon} bold>
            ✨ Delt fra Claude
          </Text>
          <Text wrap="wrap">{m.body}</Text>
        </Box>
      ) : isMine ? (
        <Box borderStyle="round" borderColor={accent} backgroundColor={accent} paddingX={1}>
          <Text color="#FFFFFF" wrap="wrap">
            {m.body}
          </Text>
        </Box>
      ) : (
        <Box borderStyle="round" borderColor="inactive" paddingX={1}>
          <Text wrap="wrap">{m.body}</Text>
        </Box>
      )

      rows.push(
        isMine ? (
          <Box key={`m-${m.id}`} flexDirection="column" alignItems="flex-end" marginTop={isNewGroup ? 1 : 0}>
            {isNewGroup && <Text dimColor>{clock(m.created_at)}</Text>}
            {bubble}
          </Box>
        ) : (
          <Box key={`m-${m.id}`} flexDirection="row" gap={1} marginTop={isNewGroup ? 1 : 0}>
            <Box width={4} flexShrink={0}>
              {isNewGroup ? avatar(m.sender_name, m.sender_email) : null}
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
              {bubble}
            </Box>
          </Box>
        ),
      )
    })

    const others = c.members.filter(m => m.toLowerCase() !== me)

    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={accent} bold>
              {room ? `# ${room.name}` : '💬 Team Chat'}
            </Text>
            <Text dimColor>
              {room ? `${c.members.length} ${c.members.length === 1 ? 'medlem' : 'medlemmer'}` : 'Ingen rum endnu'}
            </Text>
          </Box>
          {room && Svg && c.members.length > 0 && (
            <Svg source={stackSvg(c.members)} alt={c.members.map(nameFrom).join(', ')} width={stackWidth(c.members.length)} height={26} />
          )}
          {room && (
            <Box borderStyle="round" borderColor={v.mode === 'invite' ? accent : 'inactive'} paddingX={1}>
              <Button key="invite-toggle" label="＋ Inviter" plain onPress={toggle('invite')} />
            </Box>
          )}
        </Box>

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {c.rooms.map(r => {
            const isActive = r.id === c.roomId

            return (
              <Box
                key={`pill-${r.id}`}
                borderStyle="round"
                borderColor={isActive ? accent : 'inactive'}
                backgroundColor={isActive ? accent : undefined}
                paddingX={1}
                hover={isActive ? undefined : { borderColor: accent }}
              >
                <Button key={`room-${r.id}`} label={r.name} plain onPress={() => openRoom($, r.id)} />
              </Box>
            )
          })}
          <Box key="pill-new" borderStyle="round" borderColor="inactive" borderDimColor paddingX={1} hover={{ borderColor: accent }}>
            <Button key="new-room-toggle" label="＋ Nyt rum" plain dimColor onPress={toggle('new-room')} />
          </Box>
        </Box>
      </Box>
    )

    const body = !room ? (
      <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor="inactive" paddingX={2} paddingY={1} gap={1}>
        <Text>🏝️</Text>
        <Text bold>Du er ikke med i et rum endnu</Text>
        <Text dimColor wrap="wrap">
          Opret et med "＋ Nyt rum", eller bed en kollega invitere dig.
        </Text>
      </Box>
    ) : rows.length === 0 ? (
      <Box flexDirection="column" alignItems="center" paddingY={2} gap={1}>
        <Text>👋</Text>
        <Text bold>{`Velkommen til ${room.name}`}</Text>
        <Text dimColor wrap="wrap">
          {others.length > 0 ? `Sig hej til ${others.map(nameFrom).join(' og ')}.` : 'Inviter en kollega, og sig hej.'}
        </Text>
      </Box>
    ) : (
      <Box flexDirection="column">{rows}</Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        {header}
        {modeCard}
        {body}
        {error}
        {room && (
          <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
            <Input
              key="compose"
              placeholder={`Skriv til ${room.name}…`}
              submitLabel="send"
              value={text}
              autoFocus
              onInput={value => void update($, draft, () => value)}
              onSubmit={value => {
                void update($, draft, () => '')
                void send($, value)
              }}
            />
          </Box>
        )}
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          {room && reply && (
            <Box key="share-pill" borderStyle="round" borderColor={lagoon} paddingX={1} hover={{ backgroundColor: lagoon }}>
              <Button key="share-reply" label="✨ Del Claudes seneste svar" plain onPress={() => send($, reply, 'share')} />
            </Box>
          )}
          <Box flexGrow={1} />
          {avatar(c.name ?? '?', c.me ?? '', 20)}
          <Text dimColor>{c.name ?? ''}</Text>
          <Button key="sign-out" label="Log ud" plain dimColor onPress={() => signOut($)} />
        </Box>
      </Box>
    )
  })
}
