import { expect, test } from 'claude-code/testing'

const props = { title: '💬 Chat', isFocused: true, bodyColumns: 60 } as never

const json = (status: number, body: unknown) => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: sign in with a code, read the room and send a message`, async ($, on) => {
    const store = new Map<string, unknown>()
    const sent: unknown[] = []

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
    on('clock.now', () => ({ value: Date.UTC(2026, 9, 15, 10) }))
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    on('store.set', (_, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    on('http.fetch', (_, e) => {
      const url = e.url
      const method = e.init?.method ?? 'GET'

      if (url.endsWith('/auth/v1/otp')) return json(200, {})
      if (url.endsWith('/auth/v1/verify')) {
        return json(200, {
          access_token: 'jwt',
          refresh_token: 'refresh',
          expires_in: 3600,
          user: { email: 'amalie@firma.dk' },
        })
      }
      if (url.includes('/rest/v1/rooms')) return json(200, [{ id: 'r1', name: 'Amalie & Cecilie' }])
      if (url.includes('/rest/v1/room_members')) {
        return json(200, [{ email: 'amalie@firma.dk' }, { email: 'cecilie@firma.dk' }])
      }
      if (url.includes('/rest/v1/messages') && method === 'POST') {
        const body = JSON.parse(e.init?.body ?? '{}') as { body: string; sender_name: string }
        sent.push(body)
        return json(201, [
          {
            id: 2,
            sender_email: 'amalie@firma.dk',
            sender_name: body.sender_name,
            body: body.body,
            kind: 'text',
            created_at: '2026-10-15T10:01:00Z',
          },
        ])
      }
      if (url.includes('/rest/v1/messages')) {
        return json(200, [
          {
            id: 1,
            sender_email: 'cecilie@firma.dk',
            sender_name: 'Cecilie',
            body: 'Hej Amalie!',
            kind: 'text',
            created_at: '2026-10-15T10:00:00Z',
          },
        ])
      }

      return json(404, { message: 'not mocked' })
    })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })

    await ui.input({ key: 'email', text: 'Amalie@Firma.dk' })
    expect(await ui.find({ text: /sendt en mail til amalie@firma\.dk/ })).toBeDefined()

    await ui.input({ key: 'code', text: '123 456' })
    expect(await ui.find({ text: /Hej Amalie!/ })).toBeDefined()
    expect(await ui.find({ text: /2 medlemmer/ })).toBeDefined()
    expect(await ui.find({ text: /# Amalie & Cecilie/ })).toBeDefined()
    expect(store.get('session')).toMatchObject({ email: 'amalie@firma.dk' })

    await ui.input({ key: 'compose', text: 'Hvad så?' })
    expect(sent).toEqual([{ room_id: 'r1', sender_name: 'Amalie', body: 'Hvad så?', kind: 'text' }])
    expect(await ui.find({ text: /Hvad så\?/ })).toBeDefined()
  })

  test(`${surface}: a copied mail link signs in, even wrapped by Outlook Safe Links`, async ($, on) => {
    const verified: unknown[] = []
    const store = new Map<string, unknown>()

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
    on('clock.now', () => ({ value: Date.UTC(2026, 9, 15, 10) }))
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    on('store.set', (_, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('http.fetch', (_, e) => {
      if (e.url.endsWith('/auth/v1/otp')) return json(200, {})
      if (e.url.endsWith('/auth/v1/verify')) {
        verified.push(JSON.parse(e.init?.body ?? '{}'))
        return json(200, { access_token: 'jwt', refresh_token: 'r', expires_in: 3600, user: { email: 'cej@firma.dk' } })
      }
      return json(200, [])
    })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'email', text: 'cej@firma.dk' })

    await ui.input({ key: 'code', text: 'https://evil.example/auth/v1/verify?token=x&type=signup' })
    expect(await ui.find({ text: /kommer ikke fra chat-login-mailen/ })).toBeDefined()
    expect(verified).toEqual([])

    const link = 'https://yqdumafjvdyabojuajeo.supabase.co/auth/v1/verify?token=pkce_abc123&type=signup&redirect_to=http://localhost:3000'
    const safe = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(link)}&data=05%7C02`
    await ui.input({ key: 'code', text: safe })

    expect(verified).toEqual([{ token_hash: 'pkce_abc123', type: 'signup' }])
    expect(await ui.find({ text: /Du er ikke med i et rum endnu/ })).toBeDefined()
  })

  test(`${surface}: a wrong email never reaches the server`, async ($, on) => {
    let calls = 0
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
    on('http.fetch', () => {
      calls += 1
      return json(200, {})
    })

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    await ui.input({ key: 'email', text: 'ikke en mail' })

    expect(await ui.find({ text: /ligner ikke en e-mail/ })).toBeDefined()
    expect(calls).toBe(0)
  })
}
