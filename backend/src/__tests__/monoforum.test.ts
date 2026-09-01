import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';
import { getInputPeer } from 'telegram/Utils';
import { returnBigInt } from 'telegram/Helpers';
import { findMonoforum, monoforumEntity } from '../tg/monoforum';

type ChannelFields = {
  id: number;
  accessHash?: number;
  title: string;
  monoforum?: boolean;
  broadcastMessagesAllowed?: boolean;
  linkedMonoforumId?: number;
};

const channel = (f: ChannelFields) =>
  new Api.Channel({
    id: returnBigInt(f.id),
    accessHash: f.accessHash != null ? returnBigInt(f.accessHash) : undefined,
    title: f.title,
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    megagroup: !f.monoforum,
    monoforum: f.monoforum,
    broadcastMessagesAllowed: f.broadcastMessagesAllowed,
    linkedMonoforumId: f.linkedMonoforumId != null ? returnBigInt(f.linkedMonoforumId) : undefined,
  });

describe('findMonoforum', () => {
  // What channels.getFullChannel returns for a channel with direct messages on: the channel,
  // its linked discussion group, and the monoforum
  const chats = [
    channel({ id: 1001, accessHash: 5555, title: 'Test Channel', broadcastMessagesAllowed: true, linkedMonoforumId: 2002 }),
    channel({ id: 3003, accessHash: 4444, title: 'Discussion group' }),
    channel({ id: 2002, accessHash: 7777, title: 'Test Channel Messages', monoforum: true, linkedMonoforumId: 1001 }),
  ];

  it('picks the monoforum out of the chats returned beside the channel', () => {
    expect(findMonoforum(chats, '2002')).toEqual({
      chatId: 'c2002',
      accessHash: '7777',
      title: 'Test Channel Messages',
    });
  });

  it('does not mistake the linked discussion group for one', () => {
    expect(findMonoforum(chats, '3003')).toBeNull();
  });

  it('reports nothing when the monoforum did not come back', () => {
    expect(findMonoforum([chats[0], chats[1]], '2002')).toBeNull();
  });

  it('reports nothing when it came back without an access hash, which no peer works without', () => {
    const hashless = [channel({ id: 2002, title: 'Test Channel Messages', monoforum: true })];
    expect(findMonoforum(hashless, '2002')).toBeNull();
  });
});

describe('monoforumEntity', () => {
  it('rebuilds a peer GramJS can send to from nothing but an ID and an access hash', () => {
    const peer = getInputPeer(
      monoforumEntity({ chatId: 'c2002', accessHash: '7777', title: 'Test Channel Messages' }),
    ) as Api.InputPeerChannel;

    expect(peer).toBeInstanceOf(Api.InputPeerChannel);
    expect(peer.channelId.toString()).toBe('2002');
    expect(peer.accessHash.toString()).toBe('7777');
  });

  it('round-trips a target found in a full-channel reply', () => {
    const target = findMonoforum(
      [channel({ id: 2002, accessHash: 7777, title: 'Msgs', monoforum: true, linkedMonoforumId: 1001 })],
      '2002',
    );
    const peer = getInputPeer(monoforumEntity(target!)) as Api.InputPeerChannel;
    expect(peer.channelId.toString()).toBe('2002');
    expect(peer.accessHash.toString()).toBe('7777');
  });
});
