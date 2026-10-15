-- Team Chat v2: no e-mail login. Each computer signs in as an anonymous
-- Supabase user; a room is joined with its invite code; everyone picks a name.
-- Row Level Security still decides who reads and writes what.

-- Out with v1 -----------------------------------------------------------------
drop table if exists public.messages cascade;
drop table if exists public.room_members cascade;
drop table if exists public.rooms cascade;
drop function if exists public.create_room(text);
drop function if exists public.is_room_member(uuid);
drop function if exists admin.issue_invite_key(text);
drop schema if exists admin;

-- Tables ----------------------------------------------------------------------
create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  invite_code text not null unique,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.room_members (
  room_id      uuid not null references public.rooms (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  last_read_id bigint not null default 0,
  joined_at    timestamptz not null default now(),
  primary key (room_id, user_id)
);
-- One "Amalie" per room: nobody can pose as someone else in it.
create unique index room_members_name_idx on public.room_members (room_id, lower(btrim(display_name)));
create index room_members_user_idx on public.room_members (user_id);

create table public.messages (
  id          bigint generated always as identity primary key,
  room_id     uuid not null references public.rooms (id) on delete cascade,
  sender_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_name text not null default '',
  body        text not null check (char_length(body) between 1 and 8000),
  kind        text not null default 'text' check (kind in ('text', 'share')),
  created_at  timestamptz not null default now()
);
create index messages_room_id_idx on public.messages (room_id, id);

-- Helpers ---------------------------------------------------------------------
create or replace function public.is_room_member(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members m where m.room_id = target and m.user_id = auth.uid());
$$;

-- XXXX-XXXX from an alphabet without look-alikes (no 0/O, 1/I/L).
create or replace function public.new_invite_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
begin
  for i in 0..7 loop
    code := code || substr(alphabet, 1 + (get_byte(bytes, i) % length(alphabet)), 1);
    if i = 3 then code := code || '-'; end if;
  end loop;
  return code;
end;
$$;

-- The sender and their name in the room come from the server, never the client.
create or replace function public.stamp_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sender_id := auth.uid();
  select m.display_name into new.sender_name
    from public.room_members m where m.room_id = new.room_id and m.user_id = auth.uid();
  if new.sender_name is null then
    raise exception 'not a member of this room' using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;
create trigger messages_stamp before insert on public.messages for each row execute function public.stamp_message();

-- Calls the plugin makes ------------------------------------------------------
create or replace function public.create_room(room_name text, my_name text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  new_room public.rooms;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.rooms (name, invite_code, created_by)
    values (btrim(room_name), public.new_invite_code(), auth.uid())
    returning * into new_room;
  insert into public.room_members (room_id, user_id, display_name)
    values (new_room.id, auth.uid(), btrim(my_name));
  return json_build_object('id', new_room.id, 'name', new_room.name, 'invite_code', new_room.invite_code);
end;
$$;

create or replace function public.join_room(code text, my_name text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  target public.rooms;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into target from public.rooms r where r.invite_code = upper(btrim(code));
  if target.id is null then raise exception 'unknown_code' using errcode = 'P0002'; end if;

  if not exists (select 1 from public.room_members m where m.room_id = target.id and m.user_id = auth.uid()) then
    begin
      insert into public.room_members (room_id, user_id, display_name) values (target.id, auth.uid(), btrim(my_name));
    exception when unique_violation then
      raise exception 'name_taken' using errcode = '23505';
    end;
  end if;
  return json_build_object('id', target.id, 'name', target.name, 'invite_code', target.invite_code);
end;
$$;

-- Renames me in every room I am in; refuses where the name is someone else's.
create or replace function public.set_my_name(my_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update public.room_members set display_name = btrim(my_name) where user_id = auth.uid();
exception when unique_violation then
  raise exception 'name_taken' using errcode = '23505';
end;
$$;

create or replace function public.leave_room(target uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.room_members where room_id = target and user_id = auth.uid();
$$;

create or replace function public.mark_read(target uuid, upto bigint)
returns void language sql security definer set search_path = '' as $$
  update public.room_members set last_read_id = greatest(last_read_id, upto)
   where room_id = target and user_id = auth.uid();
$$;

-- My rooms, each with its code, members and what I have not read yet.
create or replace function public.my_rooms()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(row_to_json(x) order by x.created_at), '[]'::json) from (
    select r.id, r.name, r.invite_code, r.created_at,
      (select json_agg(json_build_object('user_id', o.user_id, 'name', o.display_name) order by o.joined_at)
         from public.room_members o where o.room_id = r.id) as members,
      (select count(*) from public.messages msg
         where msg.room_id = r.id and msg.id > me.last_read_id and msg.sender_id <> auth.uid()) as unread,
      (select max(msg.id) from public.messages msg where msg.room_id = r.id) as last_id
    from public.room_members me join public.rooms r on r.id = me.room_id
    where me.user_id = auth.uid()
  ) x;
$$;

-- Grants: only signed-in (anonymous included) users, only what the plugin uses.
revoke all on public.rooms, public.room_members, public.messages from anon, authenticated;
grant select on public.messages to authenticated;
grant insert (room_id, body, kind) on public.messages to authenticated;
grant delete on public.messages to authenticated;

revoke all on function public.is_room_member(uuid), public.new_invite_code(), public.stamp_message(),
  public.create_room(text, text), public.join_room(text, text), public.set_my_name(text),
  public.leave_room(uuid), public.mark_read(uuid, bigint), public.my_rooms() from public, anon;
grant execute on function public.create_room(text, text), public.join_room(text, text), public.set_my_name(text),
  public.leave_room(uuid), public.mark_read(uuid, bigint), public.my_rooms() to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;

-- Row Level Security ----------------------------------------------------------
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.messages     enable row level security;

create policy "members read messages" on public.messages
  for select to authenticated using (public.is_room_member(room_id));
create policy "members send messages" on public.messages
  for insert to authenticated with check (public.is_room_member(room_id));
create policy "delete own messages" on public.messages
  for delete to authenticated using (sender_id = auth.uid());
