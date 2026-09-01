import { Api, TelegramClient } from "telegram";

// Channel Direct Messages -- "monoforums" -- let a subscriber message a channel privately.
// Enabling them on a channel sets broadcast_messages_allowed and populates
// linked_monoforum_id with the ID of a hidden supergroup; to send a direct message the
// subscriber just sends to that supergroup, with no need to join it first.
//
// The fields arrived in TL layer 204 and GramJS is pinned to 198, so its channel constructor
// predates them and the server never sends them on our connection. Rather than move the whole
// app to a newer layer, we wrap a single call in invokeWithLayer and read that layer's channel
// by hand, in the style of passkeys.ts:
//   invokeWithLayer#da9b0d0d {X:Type} layer:int query:!X = X;
//   channels.getChannels#0a7f6bbb id:Vector<InputChannel> = messages.Chats;
//   inputChannel#f35aec28 channel_id:long access_hash:long = InputChannel;
//   messages.chats#64ff9fd5 chats:Vector<Chat> = messages.Chats;
//   messages.chatsSlice#9cd81144 count:int chats:Vector<Chat> = messages.Chats;
//   channel#1c32b11c flags:# ... flags2:# ... broadcast_messages_allowed:flags2.16?true
//     monoforum:flags2.17?true id:long access_hash:flags.13?long title:string
//     username:flags.6?string photo:ChatPhoto date:int
//     restriction_reason:flags.9?Vector<RestrictionReason> admin_rights:flags.14?ChatAdminRights
//     banned_rights:flags.15?ChatBannedRights default_banned_rights:flags.18?ChatBannedRights
//     participants_count:flags.17?int usernames:flags2.0?Vector<Username>
//     stories_max_id:flags2.4?RecentStory color:flags2.7?PeerColor
//     profile_color:flags2.8?PeerColor emoji_status:flags2.9?EmojiStatus level:flags2.10?int
//     subscription_until_date:flags2.11?int bot_verification_icon:flags2.13?long
//     send_paid_messages_stars:flags2.14?long linked_monoforum_id:flags2.18?long = Chat;
//   recentStory#711d692d flags:# live:flags.0?true max_id:flags.1?int = RecentStory;
// See https://core.telegram.org/api/monoforum
//
// Every nested type the channel references is byte-identical between layer 198 and 225, so
// GramJS's own readers parse them; only RecentStory is new enough to need reading here.

/** The layer CHANNEL_L225 was read from. Bumping one without the other misreads the reply. */
const MONOFORUM_LAYER = 225;
const CHANNEL_L225 = 0x1c32b11c;

const INVOKE_WITH_LAYER = 0xda9b0d0d;
const GET_CHANNELS = 0x0a7f6bbb;
const INPUT_CHANNEL = 0xf35aec28;
const VECTOR = 0x1cb5c415;
const MESSAGES_CHATS = 0x64ff9fd5;
const MESSAGES_CHATS_SLICE = 0x9cd81144;
const RECENT_STORY = 0x711d692d;

const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
const i32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
};
const i64 = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt.asIntN(64, v), 0);
  return b;
};

const has = (flags: number, bit: number): boolean => (flags & (1 << bit)) !== 0;

/** Thrown when the reply is not the layer we asked for, so the reader stops rather than guessing. */
class UnexpectedLayerError extends Error {}

export type MonoforumChannel = {
  id: string;
  accessHash: string | null;
  title: string;
  username: string | null;
  /** Set on the monoforum itself, never on the channel it belongs to. */
  monoforum: boolean;
  /** Set on a channel whose owner has turned direct messages on. */
  broadcastMessagesAllowed: boolean;
  /** On a channel, the monoforum's ID; on a monoforum, the channel's. */
  linkedMonoforumId: string | null;
};

// recentStory#711d692d -- too new for GramJS, and only ever skipped over
function skipRecentStory(reader: any): void {
  if (reader.readInt(false) !== RECENT_STORY) throw new UnexpectedLayerError("recentStory");
  const flags = reader.readInt(false);
  if (has(flags, 1)) reader.readInt(); // max_id
}

function skipVector(reader: any): void {
  if (reader.readInt(false) !== VECTOR) throw new UnexpectedLayerError("vector");
  const count = reader.readInt();
  for (let i = 0; i < count; i++) reader.tgReadObject();
}

/** Reads channel#1c32b11c, the constructor ID already consumed. */
function readChannel(reader: any): MonoforumChannel {
  const flags = reader.readInt(false);
  const flags2 = reader.readInt(false);
  const id = reader.readLong();
  const accessHash = has(flags, 13) ? reader.readLong() : null;
  const title = reader.tgReadString();
  const username = has(flags, 6) ? reader.tgReadString() : null;
  reader.tgReadObject(); // photo:ChatPhoto
  reader.readInt(); // date
  if (has(flags, 9)) skipVector(reader); // restriction_reason
  if (has(flags, 14)) reader.tgReadObject(); // admin_rights
  if (has(flags, 15)) reader.tgReadObject(); // banned_rights
  if (has(flags, 18)) reader.tgReadObject(); // default_banned_rights
  if (has(flags, 17)) reader.readInt(); // participants_count
  if (has(flags2, 0)) skipVector(reader); // usernames
  if (has(flags2, 4)) skipRecentStory(reader); // stories_max_id
  if (has(flags2, 7)) reader.tgReadObject(); // color
  if (has(flags2, 8)) reader.tgReadObject(); // profile_color
  if (has(flags2, 9)) reader.tgReadObject(); // emoji_status
  if (has(flags2, 10)) reader.readInt(); // level
  if (has(flags2, 11)) reader.readInt(); // subscription_until_date
  if (has(flags2, 13)) reader.readLong(); // bot_verification_icon
  if (has(flags2, 14)) reader.readLong(); // send_paid_messages_stars
  const linkedMonoforumId = has(flags2, 18) ? reader.readLong() : null;

  return {
    id: id.toString(),
    accessHash: accessHash != null ? accessHash.toString() : null,
    title,
    username,
    monoforum: has(flags2, 17),
    broadcastMessagesAllowed: has(flags2, 16),
    linkedMonoforumId: linkedMonoforumId != null ? linkedMonoforumId.toString() : null,
  };
}

/**
 * Reads messages.Chats, keeping the layer-225 channels and skipping the other Chat variants --
 * chatEmpty, chat, chatForbidden and channelForbidden are unchanged since 198, so GramJS reads them.
 */
export function readChats(reader: any): MonoforumChannel[] {
  const kind = reader.readInt(false);
  if (kind === MESSAGES_CHATS_SLICE) reader.readInt(); // count
  else if (kind !== MESSAGES_CHATS) throw new UnexpectedLayerError("messages.Chats");
  if (reader.readInt(false) !== VECTOR) throw new UnexpectedLayerError("vector");

  const count = reader.readInt();
  const channels: MonoforumChannel[] = [];
  for (let i = 0; i < count; i++) {
    const start = reader.tellPosition();
    if (reader.readInt(false) === CHANNEL_L225) {
      channels.push(readChannel(reader));
    } else {
      reader.setPosition(start);
      reader.tgReadObject();
    }
  }
  return channels;
}

export type ChannelRef = { channelId: bigint; accessHash: bigint };

// A minimal request object shaped like a GramJS TLRequest: invoke() only needs
// classType, resolve(), getBytes() and readResult().
class GetChannelsAtLayerRequest {
  CONSTRUCTOR_ID = INVOKE_WITH_LAYER;
  SUBCLASS_OF_ID = 0;
  className = "invokeWithLayer";
  classType = "request" as const;

  constructor(private readonly refs: ChannelRef[]) {}

  async resolve() {
    /* peers are already input refs -- nothing to resolve */
  }

  getBytes(): Buffer {
    const parts = [
      u32(INVOKE_WITH_LAYER),
      i32(MONOFORUM_LAYER),
      u32(GET_CHANNELS),
      u32(VECTOR),
      i32(this.refs.length),
    ];
    for (const ref of this.refs) {
      parts.push(u32(INPUT_CHANNEL), i64(ref.channelId), i64(ref.accessHash));
    }
    return Buffer.concat(parts);
  }

  // Named `channels` rather than `chats` so GramJS's post-invoke entity processing,
  // which expects its own Api types, finds nothing to walk and no-ops.
  readResult(reader: any): { channels: MonoforumChannel[] } {
    return { channels: readChats(reader) };
  }
}

/** The hidden supergroup a channel's direct messages land in. */
export type ChannelDmTarget = {
  /** The monoforum's own chatId, which every other messenger call takes as-is. */
  chatId: string;
  accessHash: string;
  title: string;
};

function toChannelRef(channel: Api.Channel): ChannelRef | null {
  const accessHash = (channel as any).accessHash;
  if (accessHash == null) return null;
  return {
    channelId: BigInt(channel.id.toString()),
    accessHash: BigInt(accessHash.toString()),
  };
}

/**
 * The monoforum entity, as a channel GramJS can send to and read from. The layer-198 class
 * carries no monoforum fields, but an ID and an access hash are all a peer reference needs.
 */
export function monoforumEntity(target: ChannelDmTarget): Api.Channel {
  return new Api.Channel({
    id: BigInt(target.chatId.slice(1)) as any,
    accessHash: BigInt(target.accessHash) as any,
    title: target.title,
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    megagroup: true,
  });
}

// An access hash is only good for the account it was issued to, so targets are kept per
// account. They outlive the live client, which is evicted once an account goes idle: a direct
// message chat reopened from a restored session still knows the peer it points at, which the
// dialog list cannot supply until the conversation has messages in it.
const dmTargets = new Map<string, ChannelDmTarget>();

const dmKey = (accountId: number, chatId: string) => `${accountId}:${chatId}`;

export function rememberChannelDm(accountId: number, target: ChannelDmTarget): void {
  dmTargets.set(dmKey(accountId, target.chatId), target);
}

/** The monoforum behind a direct-message chatId, when this account has resolved it before. */
export function cachedChannelDm(
  accountId: number,
  chatId: string,
): ChannelDmTarget | null {
  return dmTargets.get(dmKey(accountId, chatId)) ?? null;
}

export function forgetAccountChannelDms(accountId: number): void {
  const prefix = `${accountId}:`;
  for (const key of dmTargets.keys()) {
    if (key.startsWith(prefix)) dmTargets.delete(key);
  }
}

/**
 * Finds where direct messages to `channel` go, or null when its owner has not turned them on
 * (and when the reply is not layer 225, so an unrecognised schema reads as "unavailable"
 * rather than as garbage).
 */
export async function resolveChannelDm(
  client: TelegramClient,
  channel: Api.Channel,
): Promise<ChannelDmTarget | null> {
  const ref = toChannelRef(channel);
  if (!ref) return null;

  let channels: MonoforumChannel[];
  try {
    const result = (await client.invoke(
      new GetChannelsAtLayerRequest([ref]) as any,
    )) as unknown as { channels: MonoforumChannel[] };
    channels = result.channels;
  } catch {
    return null; // layer refused, or the schema moved on -- direct messages read as unavailable
  }

  const id = channel.id.toString();
  const self = channels.find((c) => c.id === id);
  const monoforumId = self?.linkedMonoforumId;
  if (!monoforumId) return null;

  // The monoforum rides along in the same chats vector, the way Telegram ships every peer it
  // refers to. Falling back to the full channel covers the case where it does not.
  const inline = channels.find((c) => c.id === monoforumId && c.accessHash);
  if (inline?.accessHash) {
    return { chatId: `c${inline.id}`, accessHash: inline.accessHash, title: channel.title };
  }

  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channel as any }));
  const linked = (full.chats as (Api.Chat | Api.Channel)[]).find(
    (c) => c.id.toString() === monoforumId && c instanceof Api.Channel && (c as any).accessHash,
  ) as Api.Channel | undefined;
  if (!linked) return null;

  return {
    chatId: `c${linked.id.toString()}`,
    accessHash: (linked as any).accessHash.toString(),
    title: channel.title,
  };
}
