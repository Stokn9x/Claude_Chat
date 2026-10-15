import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const props = { title: '💬 Chat', isFocused: true, bodyColumns: 60 } as never

const json = (status: number, body: unknown) => ({
  value: { status, ok: status < 300, headers: {}, text: body === undefined ? '' : JSON.stringify(body) },
})

type Msg = { id: number; sender_id: string; sender_name: string; body: string; kind: string; created_at: string }

// A small Supabase: one anonymous user per signup, rooms with codes, members, messages.
const fakeSupabase = (seed: { rooms?: { id: string; name: string; code: string; members: { user_id: string; name: string }[] }[]; messages?: Msg[] } = {}) => {
  const rooms = seed.rooms ?? []
  const messages: Msg[] = seed.messages ?? []
  const calls: { path: string; body: unknown }[] = []
  let users = 0
  const me = () => `user-${users}`
  const myName = { value: '' }

  const handle = (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace('https://yqdumafjvdyabojuajeo.supabase.co', '')
    const body = init?.body ? (JSON.parse(init.body) as Record<string, string>) : {}
    calls.push({ path, body })

    if (path === '/auth/v1/signup') {
      users += 1
      return json(200, { access_token: `jwt-${users}`, refresh_token: 'r', expires_in: 3600, user: { id: me() } })
    }
    if (path === '/rest/v1/rpc/my_rooms') {
      return json(
        200,
        rooms
          .filter(r => r.members.some(m => m.user_id === me()))
          .map(r => ({ id: r.id, name: r.name, invite_code: r.code, members: r.members, unread: 0, last_id: null })),
      )
    }
    if (path === '/rest/v1/rpc/create_room') {
      const room = { id: `room-${rooms.length + 1}`, name: body.room_name ?? '', code: 'NEW1-CODE', members: [{ user_id: me(), name: body.my_name ?? '' }] }
      rooms.push(room)
      return json(200, { id: room.id, name: room.name, invite_code: room.code })
    }
    if (path === '/rest/v1/rpc/join_room') {
      const room = rooms.find(r => r.code === body.code)
      if (!room) return json(400, { code: 'P0002', message: 'unknown_code' })
      if (room.members.some(m => m.name.toLowerCase() === (body.my_name ?? '').toLowerCase())) {
        return json(409, { code: '23505', message: 'name_taken' })
      }
      room.members.push({ user_id: me(), name: body.my_name ?? '' })
      return json(200, { id: room.id, name: room.name, invite_code: room.code })
    }
    if (path === '/rest/v1/rpc/set_my_name') {
      myName.value = body.my_name ?? ''
      return json(204, undefined)
    }
    if (path.startsWith('/rest/v1/rpc/')) return json(204, undefined)
    if (path.startsWith('/rest/v1/messages') && init?.method === 'POST') {
      const room = rooms.find(r => r.id === body.room_id)
      const msg = {
        id: messages.length + 1,
        sender_id: me(),
        sender_name: room?.members.find(m => m.user_id === me())?.name ?? '?',
        body: body.body ?? '',
        kind: body.kind ?? 'text',
        created_at: '2026-10-15T10:05:00Z',
      }
      messages.push(msg)
      return json(201, [msg])
    }
    if (path.startsWith('/rest/v1/messages')) {
      const roomId = /room_id=eq\.([^&]+)/.exec(path)?.[1]
      const after = Number(/id=gt\.(\d+)/.exec(path)?.[1] ?? 0)
      return json(200, messages.filter(m => (m as Msg & { room?: string }).room === roomId || roomId === 'room-1').filter(m => m.id > after).reverse())
    }

    return json(404, { message: `not mocked: ${path}` })
  }

  return { handle, calls, rooms, messages }
}

const engine = (on: On, api: ReturnType<typeof fakeSupabase>) => {
  const store = new Map<string, unknown>()
  const copied: string[] = []
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 15, 10, 10) }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('http.fetch', (_, e) => api.handle(e.url, e.init))

  return { store, copied }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: pick a name, join with a code and chat`, async ($, on) => {
    const api = fakeSupabase({
      rooms: [{ id: 'room-1', name: 'Hygge', code: 'HAV7-K2PQ', members: [{ user_id: 'cej', name: 'Cej' }] }],
      messages: [{ id: 1, sender_id: 'cej', sender_name: 'Cej', body: 'Velkommen!', kind: 'text', created_at: '2026-10-15T10:00:00Z' }],
    })
    const { store } = engine(on, api)

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'my-name', text: '  Bertram  ' })
    expect(store.get('name')).toBe('Bertram')
    expect(store.get('session')).toMatchObject({ user_id: 'user-1' })
    expect(await ui.find({ key: 'join-code' })).toBeDefined()

    await ui.input({ key: 'join-code', text: 'hav7 k2pq' })
    expect(api.calls.find(c => c.path === '/rest/v1/rpc/join_room')?.body).toEqual({ code: 'HAV7-K2PQ', my_name: 'Bertram' })
    expect(await ui.find({ text: /Velkommen!/ })).toBeDefined()

    await ui.input({ key: 'compose', text: 'Hej Cej' })
    expect(api.messages.at(-1)).toMatchObject({ body: 'Hej Cej', sender_name: 'Bertram', sender_id: 'user-1' })
    expect(await ui.find({ text: /Hej Cej/ })).toBeDefined()
  })

  test(`${surface}: an e-mail session from 0.2 is dropped for a fresh anonymous one`, async ($, on) => {
    const api = fakeSupabase()
    const { store } = engine(on, api)
    store.set('session', { access_token: 'old', refresh_token: 'r', expires_at: Date.UTC(2030, 0, 1), email: 'cej@firma.dk' })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'my-name', text: 'Cej' })

    expect(api.calls.some(c => c.path === '/auth/v1/signup')).toBe(true)
    expect(store.get('session')).toMatchObject({ user_id: 'user-1' })
  })

  test(`${surface}: create a room and copy its invitation`, async ($, on) => {
    const api = fakeSupabase()
    const { copied } = engine(on, api)

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'my-name', text: 'Amalie' })
    await ui.input({ key: 'new-room', text: '#Projekt Nord' })

    expect(api.calls.find(c => c.path === '/rest/v1/rpc/create_room')?.body).toEqual({ room_name: 'Projekt Nord', my_name: 'Amalie' })
    expect(await ui.find({ text: /NEW1-CODE/ })).toBeDefined()

    await ui.press({ key: 'copy-invite-btn' })
    expect(copied[0]).toContain('NEW1-CODE')
    expect(copied[0]).toContain('github.com/Stokn9x/Claude_Chat')
  })

  test(`${surface}: a taken name and an unknown code read as plain Danish`, async ($, on) => {
    const api = fakeSupabase({
      rooms: [{ id: 'room-1', name: 'Hygge', code: 'HAV7-K2PQ', members: [{ user_id: 'cej', name: 'Amalie' }] }],
    })
    engine(on, api)

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'my-name', text: 'amalie' })

    await ui.input({ key: 'join-code', text: 'nope' })
    expect(await ui.find({ text: /ABCD-EF23/ })).toBeDefined()
    expect(api.calls.some(c => c.path === '/rest/v1/rpc/join_room')).toBe(false)

    await ui.input({ key: 'join-code', text: 'ZZZZ-ZZZZ' })
    expect(await ui.find({ text: /intet rum med koden ZZZZ-ZZZZ/ })).toBeDefined()

    await ui.input({ key: 'join-code', text: 'HAV7-K2PQ' })
    expect(await ui.find({ text: /allerede en "amalie"/ })).toBeDefined()
  })

  test(`${surface}: a long shared Claude reply folds and unfolds`, async ($, on) => {
    const long = ['Her er planen:', '', '```powershell', ...Array.from({ length: 30 }, (_, i) => `Write-Host ${i}`), '```', '', 'SLUTNINGEN'].join('\n')
    const api = fakeSupabase({
      rooms: [{ id: 'room-1', name: 'Hygge', code: 'HAV7-K2PQ', members: [{ user_id: 'cej', name: 'Cej' }] }],
      messages: [{ id: 1, sender_id: 'cej', sender_name: 'Cej', body: long, kind: 'share', created_at: '2026-10-15T10:00:00Z' }],
    })
    engine(on, api)

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'my-name', text: 'Bip' })
    await ui.input({ key: 'join-code', text: 'HAV7-K2PQ' })

    const folded = JSON.stringify(await ui.drawn())
    expect(folded).toContain('Cej delte et svar fra Claude')
    expect(folded).not.toContain('SLUTNINGEN')
    expect(folded).toContain('Vis mere')

    await ui.press({ key: 'fold-1' })
    expect(JSON.stringify(await ui.drawn())).toContain('SLUTNINGEN')
  })
}
