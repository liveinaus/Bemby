import { Api, TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers";

// Channel Direct Messages -- "monoforums" -- let a subscriber message a channel privately.
// Enabling them on a channel sets broadcast_messages_allowed and populates linked_monoforum_id
// with the ID of a hidden supergroup; to send a direct message the subscriber just sends to
// that supergroup, with no need to join it. The fields arrived in TL layer 204, which is why
// scripts/patch-gramjs-layer.js moves GramJS off the 198 it ships with.
// See https://core.telegram.org/api/monoforum

/** The hidden supergroup a channel's direct messages land in. */
export type ChannelDmTarget = {
  /** The monoforum's own chatId, which every other messenger call takes as-is. */
  chatId: string;
  accessHash: string;
  title: string;
};

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
 * Rebuilds the monoforum as an entity to send to and read from. An ID and an access hash are
 * all a peer reference needs, so a remembered target is enough to reopen the chat without
 * asking Telegram for the channel again.
 */
export function monoforumEntity(target: ChannelDmTarget): Api.Channel {
  return new Api.Channel({
    id: returnBigInt(target.chatId.slice(1)),
    accessHash: returnBigInt(target.accessHash),
    title: target.title,
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    megagroup: true,
    monoforum: true,
  });
}

/**
 * Picks the monoforum out of the chats returned beside a channel. The linked discussion group
 * comes back in the same list, so the monoforum flag is what tells them apart.
 */
export function findMonoforum(
  chats: (Api.Chat | Api.Channel | Api.ChatEmpty | Api.ChatForbidden | Api.ChannelForbidden)[],
  monoforumId: string,
): ChannelDmTarget | null {
  const mono = chats.find(
    (c): c is Api.Channel =>
      c instanceof Api.Channel &&
      c.id.toString() === monoforumId &&
      Boolean(c.monoforum) &&
      c.accessHash != null,
  );
  if (!mono?.accessHash) return null;

  return {
    chatId: `c${mono.id.toString()}`,
    accessHash: mono.accessHash.toString(),
    title: mono.title,
  };
}

/**
 * Finds where direct messages to `channel` go, or null when its owner has not turned them on.
 * The monoforum arrives only alongside the full channel, never in the dialog list or a
 * username lookup, and its access hash cannot be guessed.
 */
export async function resolveChannelDm(
  client: TelegramClient,
  channel: Api.Channel,
): Promise<ChannelDmTarget | null> {
  const monoforumId = channel.linkedMonoforumId;
  if (!monoforumId) return null;

  const full = await client.invoke(
    new Api.channels.GetFullChannel({ channel: channel as any }),
  );
  return findMonoforum(full.chats, monoforumId.toString());
}
