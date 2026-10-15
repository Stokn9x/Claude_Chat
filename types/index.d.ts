export type Phase = 'setup' | 'chat'

export type Mode = 'none' | 'join' | 'new-room' | 'name' | 'code'

export type View = {
  phase: Phase
  error: string | null
  isBusy: boolean
  mode: Mode
}

export type Member = { user_id: string; name: string }

export type Room = {
  id: string
  name: string
  invite_code: string
  members: Member[]
  unread: number
  last_id: number | null
}

export type Message = {
  id: number
  sender_id: string
  sender_name: string
  body: string
  kind: 'text' | 'share'
  created_at: string
}

export type Chat = {
  me: string | null
  name: string | null
  rooms: Room[]
  roomId: string | null
  messages: Message[]
}

declare module 'claude-code' {
  interface PluginState {
    'team-chat': {
      view: View
      chat: Chat
      draft: string
      lastReply: string | null
      expanded: number[]
    }
  }
}
