import { expect, test } from 'claude-code/testing'

const props = { title: '💬 Chat', isFocused: true, bodyColumns: 60 } as never

const json = (status: number, body: unknown) => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: draws with a Claude reply to share, two rooms and yesterday's messages`, async ($, on) => {
    const store = new Map<string, unknown>([
      ['session', { access_token: 'jwt', refresh_token: 'r', expires_at: Date.UTC(2030, 0, 1), email: 'cej@firma.dk' }],
    ])

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('command.register', e => ({ value: { command: 'chat' } }) as never)
    on('clock.every', () => ({ value: undefined }) as never)
    on('clock.now', () => ({ value: Date.UTC(2026, 9, 15, 10) }))
    on('store.get', (_, e) => ({ value: store.get(e.key) }))
    on('store.set', (_, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('turn.complete', () => ({ text: 'Her er **svaret** fra Claude' }))
    on('session.start', (_, e) => e as never)
    on('http.fetch', (_, e) => {
      if (e.url.includes('/rest/v1/rooms')) {
        return json(200, [
          { id: 'r1', name: 'Hygge' },
          { id: 'r2', name: 'Projekt' },
        ])
      }
      if (e.url.includes('/rest/v1/room_members')) return json(200, [{ email: 'cej@firma.dk' }])
      if (e.url.includes('/rest/v1/messages')) {
        return json(200, [
          { id: 2, sender_email: 'cej@firma.dk', sender_name: 'Cej', body: 'Hejsa', kind: 'text', created_at: '2026-10-15T07:48:00Z' },
          { id: 1, sender_email: 'cej@firma.dk', sender_name: 'Cej', body: 'Første', kind: 'share', created_at: '2026-10-14T07:48:00Z' },
        ])
      }
      return json(404, {})
    })

    await $.session.start({ source: 'startup', cwd: 'C:/x' } as never)
    await $.turn.complete({ reason: 'answer', answer: 'Her er **svaret** fra Claude', durationMs: 1, isAborted: false, turnId: 't1' } as never)

    const ui = await $.ui.mount({ plugin: 'team-chat', surface, component: 'Pane', requestId: 'team-chat', props })
    const tree = await ui.drawn()
    expect(JSON.stringify(tree)).toContain('Hejsa')
    expect(await ui.find({ text: /Del Claudes seneste svar/ })).toBeDefined()
  })
}
