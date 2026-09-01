import { describe, it, expect } from 'vitest';
import { BinaryReader } from 'telegram/extensions/BinaryReader';
import { serializeBytes } from 'telegram/tl/generationHelpers';
import { getInputPeer } from 'telegram/Utils';
import { Api } from 'telegram';
import { monoforumEntity, readChats } from '../tg/monoforum';

const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); return b; };
const str = (s: string) => serializeBytes(s) as Buffer;

const CHAT_PHOTO_EMPTY = 0x37c1011c;
const RECENT_STORY = 0x711d692d;
const USERNAME = 0xb4073647;
const RESTRICTION_REASON = 0xd072acb4;
const PEER_COLOR = 0xb54b5acf;

type ChannelFields = {
  id: number;
  accessHash: number;
  title: string;
  username?: string;
  monoforum?: boolean;
  broadcastMessagesAllowed?: boolean;
  linkedMonoforumId?: number;
  /** Every optional field the reader has to step over to reach linked_monoforum_id. */
  padded?: boolean;
};

// channel#1c32b11c, built the way the server would at layer 225
function channel(f: ChannelFields): Buffer {
  let flags = 1 << 13; // access_hash
  let flags2 = 0;
  if (f.username) flags |= 1 << 6;
  if (f.broadcastMessagesAllowed) flags2 |= 1 << 16;
  if (f.monoforum) flags2 |= 1 << 17;
  if (f.linkedMonoforumId) flags2 |= 1 << 18;
  if (f.padded) {
    flags |= (1 << 9) | (1 << 17); // restriction_reason, participants_count
    flags2 |= (1 << 0) | (1 << 4) | (1 << 7) | (1 << 10) | (1 << 13) | (1 << 14);
  }

  const parts = [
    u32(0x1c32b11c), u32(flags), u32(flags2),
    i64(f.id), i64(f.accessHash), str(f.title),
    ...(f.username ? [str(f.username)] : []),
    u32(CHAT_PHOTO_EMPTY), i32(1700000000), // photo, date
  ];
  if (f.padded) {
    parts.push(u32(0x1cb5c415), i32(1), u32(RESTRICTION_REASON), str('ios'), str('porn'), str('nope'));
    parts.push(i32(42)); // participants_count
    parts.push(u32(0x1cb5c415), i32(1), u32(USERNAME), u32(1 << 1), str('alias')); // usernames
    parts.push(u32(RECENT_STORY), u32(1 << 1), i32(9)); // stories_max_id
    parts.push(u32(PEER_COLOR), u32(1 << 0), i32(3)); // color
    parts.push(i32(2)); // level
    parts.push(i64(88)); // bot_verification_icon
    parts.push(i64(99)); // send_paid_messages_stars
  }
  if (f.linkedMonoforumId) parts.push(i64(f.linkedMonoforumId));
  return Buffer.concat(parts);
}

// chatForbidden#6592a1a7 -- a variant unchanged since layer 198, so GramJS reads it
const chatForbidden = (id: number, title: string) =>
  Buffer.concat([u32(0x6592a1a7), i64(id), str(title)]);

const messagesChats = (...chats: Buffer[]) =>
  Buffer.concat([u32(0x64ff9fd5), u32(0x1cb5c415), i32(chats.length), ...chats]);

const parse = (buf: Buffer) => readChats(new BinaryReader(buf) as any);

describe('readChats', () => {
  it('reads a channel with direct messages on, and the monoforum beside it', () => {
    const result = parse(messagesChats(
      channel({ id: 1001, accessHash: 5555, title: 'Test Channel', username: 'testch', broadcastMessagesAllowed: true, linkedMonoforumId: 2002 }),
      channel({ id: 2002, accessHash: 7777, title: 'Test Channel', monoforum: true, linkedMonoforumId: 1001 }),
    ));

    expect(result).toEqual([
      { id: '1001', accessHash: '5555', title: 'Test Channel', username: 'testch', monoforum: false, broadcastMessagesAllowed: true, linkedMonoforumId: '2002' },
      { id: '2002', accessHash: '7777', title: 'Test Channel', username: null, monoforum: true, broadcastMessagesAllowed: false, linkedMonoforumId: '1001' },
    ]);
  });

  it('steps over every optional field to reach linked_monoforum_id', () => {
    const [read] = parse(messagesChats(
      channel({ id: 1001, accessHash: 5555, title: 'Padded', broadcastMessagesAllowed: true, linkedMonoforumId: 2002, padded: true }),
    ));
    expect(read.linkedMonoforumId).toBe('2002');
    expect(read.broadcastMessagesAllowed).toBe(true);
  });

  it('reports no monoforum for a channel with direct messages off', () => {
    const [read] = parse(messagesChats(channel({ id: 1001, accessHash: 5555, title: 'Plain' })));
    expect(read.linkedMonoforumId).toBeNull();
    expect(read.broadcastMessagesAllowed).toBe(false);
  });

  it('skips Chat variants it does not read, keeping the vector aligned', () => {
    const result = parse(messagesChats(
      chatForbidden(7, 'Forbidden'),
      channel({ id: 1001, accessHash: 5555, title: 'After', linkedMonoforumId: 2002 }),
    ));
    expect(result.map((c) => c.id)).toEqual(['1001']);
    expect(result[0].linkedMonoforumId).toBe('2002');
  });

  it('refuses a reply that is not the layer it was written for', () => {
    // channel#e00998b7 is layer 198's constructor: skipped, not misread as 225
    const stale = Buffer.concat([u32(0xe00998b7), u32(1 << 13), u32(0), i64(1), i64(2), str('Old'), u32(CHAT_PHOTO_EMPTY), i32(0)]);
    expect(parse(messagesChats(stale))).toEqual([]);
    expect(() => parse(Buffer.concat([u32(0xdeadbeef)]))).toThrow();
  });
});

describe('monoforumEntity', () => {
  it('makes a peer GramJS can send to, from nothing but an ID and an access hash', () => {
    const peer = getInputPeer(
      monoforumEntity({ chatId: 'c2002', accessHash: '7777', title: 'Test Channel' }),
    ) as Api.InputPeerChannel;

    expect(peer).toBeInstanceOf(Api.InputPeerChannel);
    expect(peer.channelId.toString()).toBe('2002');
    expect(peer.accessHash.toString()).toBe('7777');
  });
});
