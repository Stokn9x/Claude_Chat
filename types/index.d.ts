export type Phase = 'signed-out' | 'code' | 'chat'

export type View = {
  phase: Phase
  email: string | null
  error: string | null
  isBusy: boolean
  mode: 'none' | 'invite' | 'new-room'
}

export type Room = { id: string; name: string }

export type Message = {
  id: number
  sender_email: string
  sender_name: string
  body: string
  kind: 'text' | 'code' | 'share'
  created_at: string
}

export type Chat = {
  me: string | null
  name: string | null
  rooms: Room[]
  roomId: string | null
  members: string[]
  messages: Message[]
}

declare module 'claude-code' {
  interface PluginState {
    'team-chat': { view: View; chat: Chat; draft: string; lastReply: string | null }
  }
}
